import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from './on-execution-completed.js';

function makeCtx(calls, notify = true) {
  return {
    settings: { get: async key => (key === 'webhook.notifyOnAgentComplete' ? notify : undefined) },
    log: { error: () => {} },
    execute: async (toolId, args) => {
      calls.push({ toolId, args });
      return { success: true };
    },
  };
}

test('on-execution-completed forwards the real onAgentComplete fields, not the fabricated agentName/status/tokensUsed shape', async () => {
  const calls = [];
  await handler({ sessionId: 's1', channelId: 'default', duration: 4200, result: 'Total amount: $1,095.' }, makeCtx(calls));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolId, 'webhook.webhook_send');
  assert.deepEqual(calls[0].args.payload, {
    sessionId: 's1',
    channelId: 'default',
    result: 'Total amount: $1,095.',
    durationMs: 4200,
  });
});

test('on-execution-completed does nothing when notifyOnAgentComplete is off', async () => {
  const calls = [];
  await handler({ sessionId: 's1', channelId: 'default', duration: 0, result: null }, makeCtx(calls, false));

  assert.equal(calls.length, 0);
});
