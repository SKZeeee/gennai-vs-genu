import assert from 'node:assert/strict';
import test from 'node:test';
import { parseExAppRequest, toAgentRequest } from '../lambda/exapp-contract.js';

test('源内の質問と会話履歴をAgentCore形式へ変換する', () => {
  const request = parseExAppRequest({
    sessionId: '70bb623d-b199-4fe5-8eb2-31c1d5b788b6',
    inputs: {
      question: '  構成をレビューして  ',
      mode: 'architecture_review',
      conversation_histories: [{
        input: JSON.stringify({ question: 'この構成はどうですか' }),
        output: '可用性の確認が必要です',
      }],
    },
  });

  assert.deepEqual(toAgentRequest(request), {
    runtimeSessionId: '70bb623d-b199-4fe5-8eb2-31c1d5b788b6',
    prompt: '構成をレビューして',
    mode: 'architecture_review',
    history: [
      { role: 'user', content: 'この構成はどうですか' },
      { role: 'assistant', content: '可用性の確認が必要です' },
    ],
  });
});

test('未定義モードはgeneralへフォールバックする', () => {
  const result = toAgentRequest(parseExAppRequest({ inputs: { question: '質問', mode: 'unknown' } }));
  assert.equal(result.mode, 'general');
  assert.match(result.runtimeSessionId, /^[0-9a-f-]{36}$/);
});

test('質問がないリクエストを拒否する', () => {
  assert.throws(
    () => toAgentRequest(parseExAppRequest({ inputs: {} })),
    /inputs.question is required/,
  );
});
