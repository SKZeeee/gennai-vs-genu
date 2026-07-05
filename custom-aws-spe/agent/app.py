from strands import Agent
from strands.models import BedrockModel
from strands.tools.mcp import MCPClient
from mcp import StdioServerParameters, stdio_client
from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client
try:
    from bedrock_agentcore import BedrockAgentCoreApp
except ImportError:
    from bedrock_agentcore.runtime import BedrockAgentCoreApp
from contextlib import ExitStack
from pathlib import Path
from urllib.parse import unquote
import json
import logging
import os
import boto3

app = BedrockAgentCoreApp()
logger = logging.getLogger(__name__)
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))

AWS_MCP_ENDPOINT = os.environ.get("AWS_MCP_ENDPOINT", "https://aws-mcp.us-east-1.api.aws/mcp")
AWS_MCP_REGION = os.environ.get("AWS_MCP_REGION", "us-east-1")
AWS_MCP_SERVICE = os.environ.get("AWS_MCP_SERVICE", "aws-mcp")
ENABLE_AWS_PRICING_MCP = os.environ.get("ENABLE_AWS_PRICING_MCP", "true").lower() == "true"
AWS_PRICING_MCP_COMMAND = os.environ.get("AWS_PRICING_MCP_COMMAND", "uvx")
AWS_PRICING_MCP_ARGS = os.environ.get("AWS_PRICING_MCP_ARGS", "awslabs.aws-pricing-mcp-server@latest")
ATTACHMENT_BUCKET_NAME = os.environ.get("ATTACHMENT_BUCKET_NAME")
ATTACHMENT_KEY_PREFIX = os.environ.get("ATTACHMENT_KEY_PREFIX", "attachments/")
DEPARTMENT_CONSULT_EMAIL = os.environ.get("DEPARTMENT_CONSULT_EMAIL", "aws-consult@example.com")
MAX_TEXT_ATTACHMENT_BYTES = int(os.environ.get("MAX_TEXT_ATTACHMENT_BYTES", str(256 * 1024)))
MAX_IMAGE_ATTACHMENT_BYTES = int(os.environ.get("MAX_IMAGE_ATTACHMENT_BYTES", str(10 * 1024 * 1024)))
MAX_HISTORY_MESSAGES = int(os.environ.get("MAX_HISTORY_MESSAGES", "6"))
MAX_HISTORY_MESSAGE_CHARS = int(os.environ.get("MAX_HISTORY_MESSAGE_CHARS", "2000"))
MAX_HISTORY_TOTAL_CHARS = int(os.environ.get("MAX_HISTORY_TOTAL_CHARS", "10000"))
WORK_MODES_PATH = Path(__file__).with_name("work_modes.json")

s3_client = boto3.client("s3")

SYSTEM_PROMPT = """あなたは社内向け AWS 専門家エージェントです。
- AWS の一般的な概念説明や社内相談の前提整理では、まず手元の知識で簡潔に回答する。
- 最新仕様、料金、リージョン差、サービス制限、公式根拠が重要な設計判断では、必要な範囲に絞って AWS MCP Server を使う。
- AWS の料金、見積、コスト比較で具体的な金額や単価を出す場合だけ AWS Pricing MCP Server を使って現在の料金情報を確認する。
- Pricing MCP の結果を使う場合は、前提条件、リージョン、単価、利用量を明示し、概算であることを示す。
- MCPツールで取得した情報を根拠に回答する場合だけ、回答作成で実際に参照したURLを記録する。
- MCPツールを使った場合は回答末尾に「## 参照元」セクションを設け、参照したURLを重複排除してMarkdownリンクで列挙する。URLがツール結果に含まれない場合は推測で作らない。
- search_documentation / read_documentation / recommend の結果に含まれる url と redirected_url、Pricing MCP の get_price_list_urls が返すURLは、根拠として使った場合に参照元へ含める。
- ツール呼び出しのXMLやJSONを本文に書かない。ツールは利用可能なツール機構を通じて実行する。
- AWS のサービス選定、アーキテクチャ、セキュリティ、運用、コスト、トラブルシューティングの相談に対応する。
- AWS API 実行系ツールは使わない。回答は日本語で行う。"""

AWS_MCP_READ_ONLY_TOOL_ALLOWLIST = [
    "search_documentation",
    "read_documentation",
    "recommend",
    "list_regions",
    "get_regional_availability",
    "retrieve_skill",
    "retrieve_agent_sop",
    "aws___search_documentation",
    "aws___read_documentation",
    "aws___recommend",
    "aws___list_regions",
    "aws___get_regional_availability",
    "aws___retrieve_skill",
    "aws___retrieve_agent_sop",
]


def load_work_modes() -> dict:
    try:
        with WORK_MODES_PATH.open("r", encoding="utf-8") as fp:
            data = json.load(fp)
        return data if isinstance(data, dict) else {}
    except Exception:
        logger.exception("Failed to load work mode settings")
        return {}


WORK_MODES = load_work_modes()


def normalize_mode(mode) -> str:
    if not isinstance(mode, str):
        return "general"
    return mode if mode in WORK_MODES else "general"


def build_system_prompt(mode: str) -> str:
    mode_config = WORK_MODES.get(mode)
    if not isinstance(mode_config, dict):
        return SYSTEM_PROMPT

    label = mode_config.get("label", mode)
    instructions = mode_config.get("instructions", [])
    skill_queries = mode_config.get("required_skill_queries", [])
    instruction_lines = [
        f"今回の作業モードは「{label}」です。",
        "このモードでは以下の指示を通常指示より優先して実行してください。",
    ]

    if isinstance(skill_queries, list) and skill_queries:
        instruction_lines.append(
            "公式根拠が必要な場合は、AWS MCP Server の search_documentation / retrieve_skill で以下の観点に近い情報・Skillsを優先して確認してください: "
            + ", ".join(str(item) for item in skill_queries if item)
        )

    if isinstance(instructions, list):
        instruction_lines.extend(
            f"- {item.replace('{department_consult_email}', DEPARTMENT_CONSULT_EMAIL)}"
            for item in instructions
            if isinstance(item, str) and item.strip()
        )

    return SYSTEM_PROMPT + "\n\n" + "\n".join(instruction_lines)


def parse_payload(payload) -> tuple[str | None, list[dict], list[dict], str]:
    if isinstance(payload, (bytes, bytearray)):
        payload = payload.decode("utf-8")

    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return payload.strip() or None, [], [], "general"

    if not isinstance(payload, dict):
        return None, [], [], "general"

    attachments = payload.get("attachments")
    if not isinstance(attachments, list):
        attachments = []

    history = payload.get("history")
    if not isinstance(history, list):
        history = []

    mode = normalize_mode(payload.get("mode"))

    prompt = payload.get("prompt")
    if isinstance(prompt, str) and prompt.strip():
        return prompt.strip(), attachments, history, mode

    input_payload = payload.get("input")
    if isinstance(input_payload, dict):
        nested_prompt = input_payload.get("prompt")
        nested_attachments = input_payload.get("attachments")
        nested_history = input_payload.get("history")
        nested_mode = normalize_mode(input_payload.get("mode"))
        if isinstance(nested_prompt, str) and nested_prompt.strip():
            return (
                nested_prompt.strip(),
                nested_attachments if isinstance(nested_attachments, list) else attachments,
                nested_history if isinstance(nested_history, list) else history,
                nested_mode,
            )

    return None, attachments, history, mode


def normalize_history(history) -> list[dict]:
    if not isinstance(history, list):
        return []

    normalized = []
    total_chars = 0

    for item in history[-MAX_HISTORY_MESSAGES:]:
        if not isinstance(item, dict):
            continue

        role = item.get("role")
        content = item.get("content")
        if role not in {"user", "assistant"} or not isinstance(content, str):
            continue

        content = content.strip()
        if not content:
            continue

        if len(content) > MAX_HISTORY_MESSAGE_CHARS:
            content = content[:MAX_HISTORY_MESSAGE_CHARS] + "..."

        remaining_chars = MAX_HISTORY_TOTAL_CHARS - total_chars
        if remaining_chars <= 0:
            break
        if len(content) > remaining_chars:
            content = content[:remaining_chars] + "..."

        normalized.append({"role": role, "content": content})
        total_chars += len(content)

    return normalized


def build_prompt_with_history(prompt: str, history: list[dict]) -> str:
    normalized_history = normalize_history(history)
    if not normalized_history:
        return prompt

    history_lines = []
    for item in normalized_history:
        label = "ユーザー" if item["role"] == "user" else "アシスタント"
        history_lines.append(f"[{label}]\n{item['content']}")

    return (
        "以下は同じチャットの過去履歴です。AgentCore の内部セッションが再作成されている場合でも、"
        "この履歴を文脈として利用してください。\n\n"
        + "\n\n".join(history_lines)
        + "\n\n今回のユーザー発言:\n"
        + prompt
    )


def normalize_attachment(item) -> dict | None:
    if not isinstance(item, dict):
        return None

    storage_path = item.get("storagePath")
    file_name = item.get("fileName")
    content_type = item.get("contentType")
    file_kind = item.get("fileKind")
    size = item.get("size")

    if not all(isinstance(value, str) and value for value in [storage_path, file_name, content_type, file_kind]):
        return None
    if file_kind not in {"image", "text"}:
        return None
    if not isinstance(size, int):
        return None

    storage_path = unquote(storage_path)
    if storage_path.startswith("s3://"):
        _, _, remainder = storage_path.partition("s3://")
        bucket, _, key = remainder.partition("/")
        if bucket != ATTACHMENT_BUCKET_NAME:
            return None
        storage_path = key

    if storage_path.startswith("/"):
        storage_path = storage_path[1:]
    if not storage_path.startswith(ATTACHMENT_KEY_PREFIX):
        return None

    return {
        "storagePath": storage_path,
        "fileName": file_name,
        "contentType": content_type,
        "fileKind": file_kind,
        "size": size,
    }


def image_format_from_content_type(content_type: str) -> str | None:
    format_map = {
        "image/png": "png",
        "image/jpeg": "jpeg",
        "image/jpg": "jpeg",
        "image/webp": "webp",
        "image/gif": "gif",
    }
    return format_map.get(content_type.lower())


def build_agent_input(prompt: str, attachments: list[dict], history: list[dict]):
    prompt_with_history = build_prompt_with_history(prompt, history)

    if not attachments:
        return prompt_with_history

    if not ATTACHMENT_BUCKET_NAME:
        logger.warning("Attachments were provided but ATTACHMENT_BUCKET_NAME is not configured")
        return f"{prompt_with_history}\n\n[添付ファイルは設定不備により読み込めませんでした。]"

    content_blocks = [{"text": prompt_with_history}]
    text_sections = []

    for raw_attachment in attachments:
        attachment = normalize_attachment(raw_attachment)
        if not attachment:
            logger.warning("Invalid attachment metadata ignored: %s", raw_attachment)
            continue

        if attachment["fileKind"] == "text" and attachment["size"] > MAX_TEXT_ATTACHMENT_BYTES:
            text_sections.append(f"### {attachment['fileName']}\n[サイズ超過のため読み込みをスキップしました]")
            continue

        if attachment["fileKind"] == "image" and attachment["size"] > MAX_IMAGE_ATTACHMENT_BYTES:
            text_sections.append(f"### {attachment['fileName']}\n[サイズ超過のため画像読み込みをスキップしました]")
            continue

        response = s3_client.get_object(
            Bucket=ATTACHMENT_BUCKET_NAME,
            Key=attachment["storagePath"],
        )
        body = response["Body"].read()

        if attachment["fileKind"] == "text":
            text = body.decode("utf-8", errors="replace")
            text_sections.append(f"### {attachment['fileName']}\n{text}")
            continue

        image_format = image_format_from_content_type(attachment["contentType"])
        if not image_format:
            text_sections.append(f"### {attachment['fileName']}\n[未対応の画像形式です: {attachment['contentType']}]")
            continue

        content_blocks.append({"text": f"添付画像: {attachment['fileName']}"})
        content_blocks.append({
            "image": {
                "format": image_format,
                "source": {"bytes": body},
            }
        })

    if text_sections:
        content_blocks.append({
            "text": "\n\n添付テキストファイルの内容:\n\n" + "\n\n".join(text_sections),
        })

    return content_blocks


def convert_event(event) -> dict | None:
    try:
        if not hasattr(event, 'get'):
            return None
        inner_event = event.get('event')
        if not inner_event:
            return None
        content_block_delta = inner_event.get('contentBlockDelta')
        if content_block_delta:
            text = content_block_delta.get('delta', {}).get('text')
            if text:
                return {'type': 'text', 'data': text}
        content_block_start = inner_event.get('contentBlockStart')
        if content_block_start:
            tool_use = content_block_start.get('start', {}).get('toolUse')
            if tool_use:
                return {'type': 'tool_use', 'tool_name': tool_use.get('name', 'unknown')}
        return None
    except Exception:
        return None


def split_mcp_args(raw_args: str) -> list[str]:
    try:
        parsed = json.loads(raw_args)
        if isinstance(parsed, list) and all(isinstance(item, str) for item in parsed):
            return parsed
    except json.JSONDecodeError:
        pass

    return [arg for arg in raw_args.split() if arg]


def create_aws_mcp_client() -> MCPClient:
    return MCPClient(
        lambda: aws_iam_streamablehttp_client(
            endpoint=AWS_MCP_ENDPOINT,
            aws_region=AWS_MCP_REGION,
            aws_service=AWS_MCP_SERVICE,
        ),
        tool_filters={"allowed": AWS_MCP_READ_ONLY_TOOL_ALLOWLIST},
    )


def create_pricing_mcp_client() -> MCPClient:
    pricing_env = dict(os.environ)
    pricing_env.update(
        {
            "FASTMCP_LOG_LEVEL": os.environ.get("FASTMCP_LOG_LEVEL", "ERROR"),
            "AWS_REGION": os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1")),
            "AWS_DEFAULT_REGION": os.environ.get(
                "AWS_DEFAULT_REGION",
                os.environ.get("AWS_REGION", "us-east-1"),
            ),
        }
    )

    return MCPClient(
        lambda: stdio_client(
            StdioServerParameters(
                command=AWS_PRICING_MCP_COMMAND,
                args=split_mcp_args(AWS_PRICING_MCP_ARGS),
                env=pricing_env,
            )
        ),
        prefix="aws_pricing",
    )


AWS_MCP_REQUIRED_MODES = {
    "estimate_review",
    "architecture_planning",
    "architecture_review",
}

PRICING_MCP_REQUIRED_MODES = {
    "estimate_creation",
    "estimate_review",
}


def should_enable_aws_mcp(mode: str, prompt: str) -> bool:
    if mode in AWS_MCP_REQUIRED_MODES:
        return True

    prompt_lower = prompt.lower()
    documentation_hints = [
        "最新",
        "公式",
        "ドキュメント",
        "制限",
        "上限",
        "クォータ",
        "quota",
        "limit",
        "region",
        "リージョン",
        "well-architected",
        "well architected",
    ]
    return any(hint in prompt_lower for hint in documentation_hints)


def should_enable_pricing_mcp(mode: str, prompt: str) -> bool:
    if not ENABLE_AWS_PRICING_MCP:
        return False
    if mode in PRICING_MCP_REQUIRED_MODES:
        return True

    pricing_hints = [
        "料金",
        "費用",
        "見積",
        "単価",
        "コスト",
        "price",
        "pricing",
        "cost",
        "estimate",
    ]
    prompt_lower = prompt.lower()
    return any(hint in prompt_lower for hint in pricing_hints)


@app.entrypoint
async def invoke_agent(payload, context=None):
    logger.info(
        "Agent invocation started: payload_type=%s session_id=%s",
        type(payload).__name__,
        getattr(context, "session_id", None),
    )

    prompt, attachments, history, mode = parse_payload(payload)
    if not prompt:
        logger.warning("Invocation missing prompt. payload=%s", payload)
        yield {'type': 'error', 'data': 'prompt is required'}
        return
    agent_input = build_agent_input(prompt, attachments, history)

    try:
        mcp_clients = []
        if should_enable_aws_mcp(mode, prompt):
            mcp_clients.append(("aws_mcp", create_aws_mcp_client()))
        if should_enable_pricing_mcp(mode, prompt):
            mcp_clients.append(("aws_pricing_mcp", create_pricing_mcp_client()))

        with ExitStack() as stack:
            tools = []
            for client_name, mcp_client in mcp_clients:
                stack.enter_context(mcp_client)
                client_tools = mcp_client.list_tools_sync()
                client_tool_names = [
                    getattr(tool, "tool_name", getattr(tool, "name", "unknown"))
                    for tool in client_tools
                ]
                logger.info("Loaded %s tools: %s", client_name, client_tool_names)
                tools.extend(client_tools)

            tool_names = [getattr(tool, "tool_name", getattr(tool, "name", "unknown")) for tool in tools]
            logger.info("Loaded MCP tools: %s", tool_names)

            agent_kwargs = {
                "model": BedrockModel(model_id="jp.anthropic.claude-sonnet-4-5-20250929-v1:0"),
                "system_prompt": build_system_prompt(mode),
            }
            if tools:
                agent_kwargs["tools"] = tools

            agent = Agent(**agent_kwargs)

            async for event in agent.stream_async(agent_input):
                logger.debug("Raw stream event: %s", event)
                converted = convert_event(event)
                if converted:
                    yield converted
    except Exception as exc:
        logger.exception("Agent invocation failed")
        yield {'type': 'error', 'data': str(exc)}


if __name__ == "__main__":
    app.run()
