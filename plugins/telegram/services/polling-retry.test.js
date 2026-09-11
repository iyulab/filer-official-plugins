const { test } = require('node:test');
const assert = require('node:assert/strict');
const { processUpdates, handleUpdate } = require('./polling-service.js');
const reverseIndex = require('./reverse-channel-index.js');

// Offset invariant under test (mirrors email/services/imap-service.js's cursor invariant,
// cycle-899): every update_id < telegram.pollOffset was delivered to the host or explicitly
// given up on. Before this, pollLoop advanced the offset *before* handleUpdate ran and
// handleUpdate swallowed the host being unreachable, so a Telegram message that arrived while
// the host was restarting was acknowledged to Telegram and never delivered.

const RETRY_KEY = 'telegram.pollRetry';

function makeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: async (key) => map.get(key),
    set: async (key, value) => { map.set(key, JSON.parse(JSON.stringify(value))); },
    delete: async (key) => { map.delete(key); },
  };
}

function makeCtx({ store, triggerInbound } = {}) {
  const calls = { triggerInbound: [], errors: [], warns: [] };
  return {
    calls,
    store: store ?? makeStore(),
    settings: {
      get: async (key) => (key === 'telegram.defaultChatId' ? 'chat-42' : undefined),
    },
    listChannels: async () => [],
    channels: { getIntegrationConfig: async () => null },
    triggerInbound: async (payload) => {
      calls.triggerInbound.push(payload);
      if (triggerInbound) return triggerInbound(payload);
      return new Response(null, { status: 202 });
    },
    log: {
      info: () => {},
      warn: (...args) => { calls.warns.push(args.join(' ')); },
      error: (...args) => { calls.errors.push(args.join(' ')); },
    },
  };
}

function upd(id, text = `msg ${id}`) {
  return { update_id: id, message: { chat: { id: 'chat-42' }, text } };
}

/** triggerInbound that fails transiently for the given update ids (by message text). */
function failFor(ids) {
  const texts = new Set(ids.map((id) => `msg ${id}`));
  return async (payload) => {
    if (texts.has(payload.content)) throw new Error('ECONNREFUSED');
    return new Response(null, { status: 202 });
  };
}

test('processUpdates delivers every update and returns the offset past the highest update_id', async () => {
  const ctx = makeCtx();
  await reverseIndex.build(ctx);

  const result = await processUpdates(ctx, 'tok', [upd(11), upd(12), upd(13)], 11);

  assert.deepEqual(ctx.calls.triggerInbound.map((p) => p.messageId), ['telegram-11', 'telegram-12', 'telegram-13']);
  assert.deepEqual(result, { offset: 14, deferredAttempts: 0 });
  assert.equal(ctx.store.map.has(RETRY_KEY), false);
});

test('a transient failure keeps the offset at the failed update_id, defers the rest, and records the attempt', async () => {
  const ctx = makeCtx({ triggerInbound: failFor([12]) });
  await reverseIndex.build(ctx);

  const result = await processUpdates(ctx, 'tok', [upd(11), upd(12), upd(13)], 11);

  // 11 delivered, 12 failed, 13 NOT attempted — getUpdates(offset=12) re-delivers both.
  assert.deepEqual(ctx.calls.triggerInbound.map((p) => p.messageId), ['telegram-11', 'telegram-12']);
  assert.deepEqual(result, { offset: 12, deferredAttempts: 1 });
  assert.deepEqual(ctx.store.map.get(RETRY_KEY), { 12: 1 });
  assert.equal(ctx.calls.warns.some((w) => w.includes('update_id=12') && w.includes('attempt 1/3')), true);
});

test('the third failure gives up on the update, moves past it, continues the batch, and clears its entry', async () => {
  const ctx = makeCtx({ store: makeStore({ [RETRY_KEY]: { 12: 2 } }), triggerInbound: failFor([12]) });
  await reverseIndex.build(ctx);

  const result = await processUpdates(ctx, 'tok', [upd(12), upd(13)], 12);

  assert.deepEqual(ctx.calls.triggerInbound.map((p) => p.messageId), ['telegram-12', 'telegram-13']);
  assert.deepEqual(result, { offset: 14, deferredAttempts: 0 });
  assert.equal(ctx.store.map.has(RETRY_KEY), false);
  assert.equal(ctx.calls.errors.some((e) => e.includes('update_id=12') && e.includes('3')), true);
});

test('a delivery that succeeds on retry clears its ledger entry', async () => {
  const ctx = makeCtx({ store: makeStore({ [RETRY_KEY]: { 12: 1 } }) });
  await reverseIndex.build(ctx);

  const result = await processUpdates(ctx, 'tok', [upd(12)], 12);

  assert.deepEqual(result, { offset: 13, deferredAttempts: 0 });
  assert.equal(ctx.store.map.has(RETRY_KEY), false);
});

test('updates are processed in update_id order even if yielded out of order', async () => {
  const ctx = makeCtx({ triggerInbound: failFor([12]) });
  await reverseIndex.build(ctx);

  const result = await processUpdates(ctx, 'tok', [upd(13), upd(11), upd(12)], 11);

  assert.deepEqual(ctx.calls.triggerInbound.map((p) => p.messageId), ['telegram-11', 'telegram-12']);
  assert.equal(result.offset, 12);
});

test('an update dropped by design (unmapped chat) still advances the offset', async () => {
  const ctx = makeCtx();
  await reverseIndex.build(ctx);

  const result = await processUpdates(ctx, 'tok', [{ update_id: 20, message: { chat: { id: 'stranger' }, text: 'x' } }], 20);

  assert.equal(ctx.calls.triggerInbound.length, 0);
  assert.deepEqual(result, { offset: 21, deferredAttempts: 0 });
});

// handleUpdate's failure contract: throws only for a *transient* delivery failure.

test('handleUpdate throws when the host is unreachable (transient)', async () => {
  const ctx = makeCtx({ triggerInbound: async () => { throw new Error('ECONNREFUSED'); } });
  await reverseIndex.build(ctx);

  await assert.rejects(() => handleUpdate(ctx, 'tok', upd(30)), /ECONNREFUSED/);
});

test('handleUpdate throws on a 5xx from the host (transient)', async () => {
  const ctx = makeCtx({ triggerInbound: async () => new Response('busy', { status: 503 }) });
  await reverseIndex.build(ctx);

  await assert.rejects(() => handleUpdate(ctx, 'tok', upd(31)), /503/);
});

test('handleUpdate returns normally on a 404 routing rejection and on other 4xx (permanent drops)', async () => {
  const ctx404 = makeCtx({
    triggerInbound: async () => new Response(JSON.stringify({ error: 'channel not registered' }), { status: 404 }),
  });
  await reverseIndex.build(ctx404);
  await handleUpdate(ctx404, 'tok', upd(32));

  const ctx400 = makeCtx({ triggerInbound: async () => new Response('bad payload', { status: 400 }) });
  await reverseIndex.build(ctx400);
  await handleUpdate(ctx400, 'tok', upd(33));
  assert.equal(ctx400.calls.warns.some((w) => w.includes('400')), true);
});
