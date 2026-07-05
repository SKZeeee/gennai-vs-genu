import assert from 'node:assert/strict';
import test from 'node:test';
import { collectAgentOutput } from '../lambda/sse.js';

test('SSEのtextイベントを連結する', () => {
  const raw = [
    'data: {"type":"tool_use","tool_name":"search_documentation"}',
    '',
    'data: {"type":"text","data":"回答"}',
    '',
    'data: {"type":"text","data":"です"}',
    '',
  ].join('\n');
  assert.equal(collectAgentOutput(raw), '回答です');
});

test('SSEのerrorイベントをエラーにする', () => {
  assert.throws(
    () => collectAgentOutput('data: {"type":"error","data":"失敗"}\n\n'),
    /失敗/,
  );
});
