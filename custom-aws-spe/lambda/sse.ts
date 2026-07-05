export type AgentEvent = {
  type?: string;
  data?: unknown;
};

export function collectAgentOutput(raw: string): string {
  const textParts: string[] = [];
  const errors: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === '[DONE]') continue;

    let event: AgentEvent;
    try {
      event = JSON.parse(data) as AgentEvent;
    } catch {
      continue;
    }

    if (event.type === 'text' && typeof event.data === 'string') {
      textParts.push(event.data);
    } else if (event.type === 'error' && typeof event.data === 'string') {
      errors.push(event.data);
    }
  }

  if (errors.length > 0) throw new Error(errors.join('\n'));
  if (textParts.length === 0) throw new Error('AgentCore returned no text output');
  return textParts.join('');
}
