import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { AgentAttachment, isRecord, parseExAppRequest, toAgentRequest } from './exapp-contract.js';
import { collectAgentOutput } from './sse.js';

const agentCore = new BedrockAgentCoreClient({});
const s3 = new S3Client({});
const runtimeArn = process.env.AGENT_RUNTIME_ARN;
const runtimeQualifier = process.env.AGENT_RUNTIME_QUALIFIER ?? 'DEFAULT';
const attachmentBucket = process.env.ATTACHMENT_BUCKET_NAME;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (!runtimeArn) return json(500, { error: 'AGENT_RUNTIME_ARN is not configured' });

  try {
    const processingStartedAt = new Date().toISOString();
    const body = event.body ? JSON.parse(event.body) as unknown : undefined;
    const exAppRequest = parseExAppRequest(body);
    const agentRequest = toAgentRequest(exAppRequest);
    const stableUserId = readHeader(event.headers, 'x-user-id') ?? 'anonymous';
    const attachments = await uploadAttachments(
      exAppRequest.inputs.files,
      stableUserId,
      agentRequest.runtimeSessionId,
    );

    const response = await agentCore.send(new InvokeAgentRuntimeCommand({
      agentRuntimeArn: runtimeArn,
      qualifier: runtimeQualifier,
      runtimeSessionId: agentRequest.runtimeSessionId,
      runtimeUserId: stableUserId,
      contentType: 'application/json',
      accept: 'text/event-stream',
      payload: new TextEncoder().encode(JSON.stringify({
        prompt: agentRequest.prompt,
        mode: agentRequest.mode,
        history: agentRequest.history,
        attachments,
      })),
    }));

    if (!response.response) throw new Error('AgentCore returned no response stream');
    const raw = await response.response.transformToString();

    return json(200, {
      outputs: collectAgentOutput(raw),
      timestamps: {
        processingStartedAt,
        processingEndedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('ExApp invocation failed', error);
    if (error instanceof SyntaxError) return json(400, { error: 'Request body must be valid JSON' });
    if (error instanceof Error && isClientError(error.message)) return json(400, { error: error.message });
    return json(502, { error: error instanceof Error ? error.message : 'Agent invocation failed' });
  }
}

async function uploadAttachments(
  value: unknown,
  userId: string,
  sessionId: string,
): Promise<AgentAttachment[]> {
  if (!Array.isArray(value) || value.length === 0) return [];
  if (!attachmentBucket) throw new Error('ATTACHMENT_BUCKET_NAME is not configured');

  const result: AgentAttachment[] = [];
  for (const group of value) {
    if (!isRecord(group) || !Array.isArray(group.files)) continue;
    for (const file of group.files) {
      if (!isRecord(file) || typeof file.filename !== 'string' || typeof file.content !== 'string') {
        continue;
      }
      const bytes = Buffer.from(file.content, 'base64');
      const contentType = inferContentType(file.filename);
      const fileKind = contentType.startsWith('image/') ? 'image' : 'text';
      const safeName = file.filename.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-180);
      const userHash = createHash('sha256').update(userId).digest('hex');
      const key = `attachments/exapp/${userHash}/${sessionId}/${safeName}`;

      await s3.send(new PutObjectCommand({
        Bucket: attachmentBucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }));
      result.push({ storagePath: key, fileName: file.filename, contentType, fileKind, size: bytes.length });
    }
  }
  return result;
}

function inferContentType(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  };
  if (!extension || !types[extension]) {
    throw new Error(`Unsupported attachment type: ${fileName}`);
  }
  return types[extension];
}

function readHeader(headers: Record<string, string | undefined>, name: string): string | undefined {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry?.[1];
}

function isClientError(message: string): boolean {
  return message.includes('required') || message.includes('must be') || message.startsWith('Unsupported');
}

function json(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}
