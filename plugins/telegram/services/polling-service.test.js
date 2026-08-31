const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handleUpdate, handleCallbackQuery } = require('./polling-service.js');
const reverseIndex = require('./reverse-channel-index.js');

// HD-91 regression guard: handleUpdate must route inbound messages through
// ctx.triggerInbound (a fixed, non-SSRF-checked host call) — never ctx.fetch,
// which unconditionally denies the localhost/127.0.0.1 host this call always
// targets (see plugin-context.ts / plugin-secure-context.ts's HD-91 comments).

function makeCtx({ triggerInboundResponse, store } = {}) {
  const calls = { triggerInbound: [], fetch: [], respondToHitl: [], storeDelete: [] };
  return {
    calls,
    settings: {
      get: async (key) => (key === 'telegram.defaultChatId' ? 'chat-42' : undefined),
    },
    listChannels: async () => [],
    channels: { getIntegrationConfig: async () => null },
    fetch: async (...args) => {
      calls.fetch.push(args);
      throw new Error('ctx.fetch must not be called for host-internal routing — use the typed ctx methods');
    },
    triggerInbound: async (payload) => {
      calls.triggerInbound.push(payload);
      return triggerInboundResponse ?? new Response(null, { status: 202 });
    },
    respondToHitl: async (...args) => {
      calls.respondToHitl.push(args);
    },
    store: {
      get: async (key) => store?.[key],
      delete: async (key) => { calls.storeDelete.push(key); },
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

async function withMockTelegramFetch(fn) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ ok: true }) };
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = originalFetch;
  }
}

test('handleUpdate routes a default-chat message through ctx.triggerInbound with the correct payload', async () => {
  const ctx = makeCtx();
  await reverseIndex.build(ctx);

  await handleUpdate(ctx, 'fake-token', {
    update_id: 999,
    message: { chat: { id: 'chat-42' }, text: 'What is the total amount in invoice-aug.csv?' },
  });

  assert.equal(ctx.calls.fetch.length, 0);
  assert.equal(ctx.calls.triggerInbound.length, 1);
  assert.deepEqual(ctx.calls.triggerInbound[0], {
    channelId: 'default',
    sourcePlugin: 'telegram',
    messageId: 'telegram-999',
    content: 'What is the total amount in invoice-aug.csv?',
  });
});

test('handleUpdate drops a message from an unmapped chat without calling triggerInbound or fetch', async () => {
  const ctx = makeCtx();
  await reverseIndex.build(ctx);

  await handleUpdate(ctx, 'fake-token', {
    update_id: 1000,
    message: { chat: { id: 'some-other-chat' }, text: 'hello' },
  });

  assert.equal(ctx.calls.triggerInbound.length, 0);
  assert.equal(ctx.calls.fetch.length, 0);
});

test('handleUpdate logs and does not throw when triggerInbound rejects the routing (e.g. 400/409)', async () => {
  const ctx = makeCtx({ triggerInboundResponse: new Response('bad request', { status: 400 }) });
  await reverseIndex.build(ctx);

  await assert.doesNotReject(
    handleUpdate(ctx, 'fake-token', {
      update_id: 1001,
      message: { chat: { id: 'chat-42' }, text: 'hi' },
    }),
  );
});

// HD-91 regression guard: an inline-keyboard HITL Approve/Deny tap must relay the decision via
// ctx.respondToHitl, never ctx.fetch — before this fix, every Telegram HITL response silently
// failed this call and reported "Error processing response" back to the user.
test('handleCallbackQuery relays an approve tap via ctx.respondToHitl, not ctx.fetch', async () => {
  const ctx = makeCtx({ store: { 'hitl:abc123': { agentId: 'agent-1', requestId: 'req-1' } } });

  await withMockTelegramFetch(async (telegramCalls) => {
    await handleCallbackQuery(ctx, 'fake-token', {
      id: 'cbq-1',
      data: 'hitl:a:abc123',
    });

    assert.equal(ctx.calls.fetch.length, 0);
    assert.deepEqual(ctx.calls.respondToHitl[0], ['agent-1', 'req-1', true, 'Approved via Telegram']);
    assert.deepEqual(ctx.calls.storeDelete, ['hitl:abc123']);
    assert.equal(telegramCalls.length, 1);
    assert.equal(telegramCalls[0].body.text, 'Approved ✓');
  });
});

test('handleCallbackQuery relays a deny tap via ctx.respondToHitl with approved:false', async () => {
  const ctx = makeCtx({ store: { 'hitl:xyz789': { agentId: 'agent-2', requestId: 'req-2' } } });

  await withMockTelegramFetch(async () => {
    await handleCallbackQuery(ctx, 'fake-token', {
      id: 'cbq-2',
      data: 'hitl:d:xyz789',
    });

    assert.deepEqual(ctx.calls.respondToHitl[0], ['agent-2', 'req-2', false, 'Denied via Telegram']);
  });
});
