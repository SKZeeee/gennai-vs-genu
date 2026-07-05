# 源内 ExApp版 AWS Specialist

`AWS Specialist` の API Gateway → Lambda → Bedrock AgentCore Runtimeを、源内Webの行政実務用AIアプリ（ExApp）から呼び出すための独立デプロイ資材です。

## 構成

```text
源内Web
  -> API Gateway POST /requests (x-api-key)
  -> ExApp呼び出しLambda -> Bedrock AgentCore Runtime
     - inputsをAgentCore形式へ変換
     - Base64添付をS3へ一時保存
     - AgentCoreのSSEをoutputsへ集約
  -> Bedrock AgentCore Runtime
  -> Bedrock / AWS MCP / AWS Pricing MCP
```

AgentCore本体は `/Users/kzt/Development/aws-specialist/amplify/agent` の実装を取り込んでいます。源内からのリクエスト内でAgentCoreの処理完了を待ち、同期レスポンスを返します。

## 前提

- Node.js 20.20以上、npm 10.8以上、Docker、AWS CLI
- デプロイ先リージョンでCDK bootstrap済み
- Bedrockモデル `jp.anthropic.claude-sonnet-4-5-20250929-v1:0` を利用可能
- ECRリポジトリ（既定名 `aws-specialist-agent`）を作成可能なAWS権限
- AgentCore、Bedrock、API Gateway、Lambda、S3、IAMを作成可能なAWS権限

## 1. AgentCoreイメージをECRへpush

```bash
export AWS_REGION=ap-northeast-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REPOSITORY=aws-specialist-agent

aws ecr describe-repositories --repository-names "$ECR_REPOSITORY" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$ECR_REPOSITORY"

aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker build --platform linux/arm64 \
  -t "$ECR_REPOSITORY:latest" agent
docker tag "$ECR_REPOSITORY:latest" \
  "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY:latest"
docker push "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPOSITORY:latest"
```

## 2. CDKデプロイ

```bash
npm install
npm run build
npm test
npx cdk deploy \
  -c imageRepositoryName=aws-specialist-agent \
  -c imageTag=latest \
  -c invokeTimeoutSeconds=300 \
  -c apiRateLimit=10 \
  -c apiBurstLimit=20 \
  -c apiMonthlyQuota=100000
```

`invokeTimeoutSeconds`は外部API側の上限です。源内側の`exAppInvokeTimeoutSeconds`にも同じ値を設定して再デプロイしてください。どちらか短い方が同期処理全体の上限になります。

デプロイ出力の `ExAppEndpoint` と `ExAppApiKeyId` を控え、APIキー値を取得します。

```bash
aws apigateway get-api-key \
  --api-key "$EX_APP_API_KEY_ID" \
  --include-value \
  --query value \
  --output text
```

## 3. 源内Webへ登録

チーム管理画面で行政実務用AIアプリを作成し、以下を設定します。

| 項目 | 設定値 |
| --- | --- |
| APIエンドポイント | CDK出力の `ExAppEndpoint` |
| APIキー | 上記コマンドで取得した値 |
| リクエスト形式 | `exapp-config.json` の内容 |
| プレースホルダー | `AWSに関する相談内容を入力してください` |
| ステータス | 動作確認後に公開 |

## API契約

リクエスト例:

```json
{
  "inputs": {
    "question": "このAWS構成をレビューしてください",
    "mode": "architecture_review",
    "conversation_histories": []
  },
  "sessionId": "70bb623d-b199-4fe5-8eb2-31c1d5b788b6"
}
```

源内からは、APIキーに加えて利用者を識別する`x-user-id`ヘッダーが送信されます。初回リクエストとステータス取得の両方で必須です。

レスポンス例:

```json
{
  "outputs": "## 診断サマリ\n...",
  "timestamps": {
    "processingStartedAt": "2026-07-02T00:00:00.000Z",
    "processingEndedAt": "2026-07-02T00:00:10.000Z"
  }
}
```

## 制約

- S3上の一時添付ファイルは1日保持されます。
- 同期処理時間は、源内側と外部API側のタイムアウト設定のうち短い方に制限されます。
- 添付はAPI Gatewayのペイロード上限内に収めます。Base64化で約1.33倍になる点に注意してください。
- 現在の添付対応はテキスト、Markdown、CSV、JSONと一般的な画像です。PDF・Office文書は別途テキスト抽出処理が必要です。
- API Gatewayは源内のExApp呼び出しLambdaからアクセスされるため、送信元IP制限は設定していません。APIキーの保管・ローテーションとUsage Planによる制限を運用してください。
