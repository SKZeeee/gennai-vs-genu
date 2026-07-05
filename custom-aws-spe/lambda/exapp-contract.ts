import { randomUUID } from 'node:crypto';

export type AgentHistory = { role: 'user' | 'assistant'; content: string };
export type AgentAttachment = {
  storagePath: string;
  fileName: string;
  contentType: string;
  fileKind: 'image' | 'text';
  size: number;
};

type ConversationHistory = {
  input?: unknown;
  output?: unknown;
};

export type ExAppRequest = {
  inputs: Record<string, unknown>;
  sessionId?: string;
};

export type AgentRequest = {
  runtimeSessionId: string;
  prompt: string;
  mode: string;
  history: AgentHistory[];
};

const SUPPORTED_MODES = new Set([
  'general',
  'estimate_creation',
  'estimate_review',
  'architecture_planning',
  'architecture_review',
  'department_consultation',
  'quiz',
]);

export function parseExAppRequest(value: unknown): ExAppRequest {
  if (!isRecord(value) || !isRecord(value.inputs)) {
    throw new Error('inputs is required');
  }

  if (value.sessionId !== undefined && typeof value.sessionId !== 'string') {
    throw new Error('sessionId must be a string');
  }

  return { inputs: value.inputs, sessionId: value.sessionId };
}

export function toAgentRequest(request: ExAppRequest): AgentRequest {
  const promptValue = request.inputs.question ?? request.inputs.prompt;
  if (typeof promptValue !== 'string' || promptValue.trim().length === 0) {
    throw new Error('inputs.question is required');
  }

  const requestedMode = request.inputs.mode;
  const mode = typeof requestedMode === 'string' && SUPPORTED_MODES.has(requestedMode)
    ? requestedMode
    : 'general';

  return {
    runtimeSessionId: request.sessionId ?? randomUUID(),
    prompt: promptValue.trim(),
    mode,
    history: toAgentHistory(request.inputs.conversation_histories),
  };
}

export function toAgentHistory(value: unknown): AgentHistory[] {
  if (!Array.isArray(value)) return [];

  const result: AgentHistory[] = [];
  for (const item of value.slice(-3)) {
    if (!isRecord(item)) continue;
    const history = item as ConversationHistory;
    const input = stringifyInput(history.input);
    if (input) result.push({ role: 'user', content: input });
    if (typeof history.output === 'string' && history.output.trim()) {
      result.push({ role: 'assistant', content: history.output.trim() });
    }
  }
  return result;
}

function stringifyInput(value: unknown): string | undefined {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isRecord(parsed)) {
        const prompt = parsed.question ?? parsed.prompt;
        if (typeof prompt === 'string') return prompt;
      }
    } catch {
      return value.trim() || undefined;
    }
    return value.trim() || undefined;
  }
  if (isRecord(value)) {
    const prompt = value.question ?? value.prompt;
    if (typeof prompt === 'string') return prompt;
    return JSON.stringify(value);
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
