import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from './on-file-changed.js';

function makeCtx(calls, notify = true) {
  return {
    settings: { get: async key => (key === 'webhook.notifyOnFileChange' ? notify : undefined) },
    log: { error: () => {} },
    execute: async (toolId, args) => {
      calls.push({ toolId, args });
      return { success: true };
    },
  };
}

test('on-file-changed forwards the real onFileChangeNotify fields (agentId/folderPath/changes), not the nonexistent "files" field', async () => {
  const calls = [];
  await handler(
    { agentId: 'a1', channelId: 'default', folderPath: 'C:/Demo/folder', changes: ['a.txt', 'b.txt'] },
    makeCtx(calls),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].toolId, 'webhook.webhook_send');
  assert.deepEqual(calls[0].args.payload, {
    agentId: 'a1',
    folderPath: 'C:/Demo/folder',
    changes: ['a.txt', 'b.txt'],
  });
});

test('on-file-changed does nothing when notifyOnFileChange is off', async () => {
  const calls = [];
  await handler({ agentId: 'a1' }, makeCtx(calls, false));

  assert.equal(calls.length, 0);
});
