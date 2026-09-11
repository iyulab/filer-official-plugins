const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  fetchNewMessages,
  handleMessage,
  primeCursor,
  stop,
  _setClientForTesting,
  _retryTimerPendingForTesting,
} = require('./imap-service.js');
const reverseIndex = require('./reverse-channel-index.js');

// Cursor invariant under test: every UID <= email.imapCursor.lastUid was either delivered to
// the host or explicitly given up on after MAX_DELIVERY_ATTEMPTS. A transient failure must not
// advance the cursor past the message that failed (that is how an email used to vanish on a
// blip — the ROADMAP's HD-31 remainder), and the retry ledger (email.imapRetry) bounds how long
// one bad message can hold the mailbox.

const CURSOR_KEY = 'email.imapCursor';
const RETRY_KEY = 'email.imapRetry';

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
      get: async (key) => (key === 'email.senderAllowlist' ? 'sender@example.com' : undefined),
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

function msg(uid) {
  return { uid, envelope: { from: [{ address: 'sender@example.com' }], messageId: `msg-${uid}` } };
}

/**
 * A fake imapflow client: `fetch` yields the given messages regardless of range (the range
 * arithmetic is asserted separately), `download` throws for any uid in `failUids`.
 */
function makeFakeClient(messages, { failUids = new Set() } = {}) {
  const calls = { fetch: [] };
  return {
    calls,
    logout: async () => {},
    fetch: async function* (range, query, opts) {
      calls.fetch.push({ range, query, opts });
      for (const m of messages) yield m;
    },
    download: async (uid) => {
      if (failUids.has(uid)) throw new Error(`download failed uid=${uid}`);
      return { content: Readable.from([`body ${uid}`]) };
    },
  };
}

test.afterEach(() => {
  stop();
  mock.timers.reset();
});

test('fetchNewMessages delivers every message and advances the cursor to the highest uid', async () => {
  const ctx = makeCtx({ store: makeStore({ [CURSOR_KEY]: { uidValidity: 7, lastUid: 10 } }) });
  await reverseIndex.build(ctx);
  const client = makeFakeClient([msg(11), msg(12), msg(13)]);
  _setClientForTesting(client);

  await fetchNewMessages(ctx);

  assert.equal(client.calls.fetch[0].range, '11:*');
  assert.deepEqual(ctx.calls.triggerInbound.map((p) => p.messageId), ['msg-11', 'msg-12', 'msg-13']);
  assert.deepEqual(ctx.store.map.get(CURSOR_KEY), { uidValidity: 7, lastUid: 13 });
  assert.equal(ctx.store.map.has(RETRY_KEY), false);
  assert.equal(_retryTimerPendingForTesting(), false);
});

test('a transient failure leaves the cursor before the failed uid, defers the rest of the batch, and schedules a retry', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeCtx({ store: makeStore({ [CURSOR_KEY]: { uidValidity: 7, lastUid: 10 } }) });
  await reverseIndex.build(ctx);
  const client = makeFakeClient([msg(11), msg(12), msg(13)], { failUids: new Set([12]) });
  _setClientForTesting(client);

  await fetchNewMessages(ctx);

  // 11 delivered, 12 failed, 13 NOT attempted — it waits behind 12 so the cursor stays contiguous.
  assert.deepEqual(ctx.calls.triggerInbound.map((p) => p.messageId), ['msg-11']);
  assert.deepEqual(ctx.store.map.get(CURSOR_KEY), { uidValidity: 7, lastUid: 11 });
  assert.deepEqual(ctx.store.map.get(RETRY_KEY), { 12: 1 });
  assert.equal(_retryTimerPendingForTesting(), true);
  assert.equal(ctx.calls.warns.some((w) => w.includes('uid=12') && w.includes('attempt 1/3')), true);

  // The retry timer re-runs the fetch from the unchanged cursor; 12 fails again → attempt 2.
  mock.timers.tick(30_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(client.calls.fetch.length, 2);
  assert.equal(client.calls.fetch[1].range, '12:*');
  assert.deepEqual(ctx.store.map.get(RETRY_KEY), { 12: 2 });
  assert.equal(_retryTimerPendingForTesting(), true);
});

test('the third failure gives up on the uid, advances past it, continues the batch, and clears its ledger entry', async () => {
  const ctx = makeCtx({
    store: makeStore({ [CURSOR_KEY]: { uidValidity: 7, lastUid: 11 }, [RETRY_KEY]: { 12: 2 } }),
  });
  await reverseIndex.build(ctx);
  const client = makeFakeClient([msg(12), msg(13)], { failUids: new Set([12]) });
  _setClientForTesting(client);

  await fetchNewMessages(ctx);

  assert.deepEqual(ctx.calls.triggerInbound.map((p) => p.messageId), ['msg-13']);
  assert.deepEqual(ctx.store.map.get(CURSOR_KEY), { uidValidity: 7, lastUid: 13 });
  assert.equal(ctx.store.map.has(RETRY_KEY), false);
  assert.equal(ctx.calls.errors.some((e) => e.includes('uid=12') && e.includes('3')), true);
  assert.equal(_retryTimerPendingForTesting(), false);
});

test('a delivery that succeeds on retry clears its ledger entry', async () => {
  const ctx = makeCtx({
    store: makeStore({ [CURSOR_KEY]: { uidValidity: 7, lastUid: 11 }, [RETRY_KEY]: { 12: 1 } }),
  });
  await reverseIndex.build(ctx);
  _setClientForTesting(makeFakeClient([msg(12)]));

  await fetchNewMessages(ctx);

  assert.deepEqual(ctx.store.map.get(CURSOR_KEY), { uidValidity: 7, lastUid: 12 });
  assert.equal(ctx.store.map.has(RETRY_KEY), false);
});

test('messages are processed in uid order even if the server yields them out of order', async () => {
  const ctx = makeCtx({ store: makeStore({ [CURSOR_KEY]: { uidValidity: 7, lastUid: 10 } }) });
  await reverseIndex.build(ctx);
  _setClientForTesting(makeFakeClient([msg(13), msg(11), msg(12)], { failUids: new Set([12]) }));

  await fetchNewMessages(ctx);

  assert.deepEqual(ctx.calls.triggerInbound.map((p) => p.messageId), ['msg-11']);
  assert.deepEqual(ctx.store.map.get(CURSOR_KEY), { uidValidity: 7, lastUid: 11 });
});

test('a UIDVALIDITY reset clears the retry ledger along with the cursor (UIDs are reused after a reset)', async () => {
  const ctx = makeCtx({
    store: makeStore({ [CURSOR_KEY]: { uidValidity: 7, lastUid: 11 }, [RETRY_KEY]: { 12: 2 } }),
  });

  await primeCursor(ctx, { uidValidity: 8n, uidNext: 100 });

  assert.deepEqual(ctx.store.map.get(CURSOR_KEY), { uidValidity: 8, lastUid: 99 });
  assert.equal(ctx.store.map.has(RETRY_KEY), false);
});

test('an unchanged UIDVALIDITY keeps the retry ledger', async () => {
  const ctx = makeCtx({
    store: makeStore({ [CURSOR_KEY]: { uidValidity: 7, lastUid: 11 }, [RETRY_KEY]: { 12: 2 } }),
  });

  await primeCursor(ctx, { uidValidity: 7n, uidNext: 100 });

  assert.deepEqual(ctx.store.map.get(RETRY_KEY), { 12: 2 });
});

test('stop() cancels a pending retry timer', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const ctx = makeCtx({ store: makeStore({ [CURSOR_KEY]: { uidValidity: 7, lastUid: 10 } }) });
  await reverseIndex.build(ctx);
  const client = makeFakeClient([msg(11)], { failUids: new Set([11]) });
  _setClientForTesting(client);

  await fetchNewMessages(ctx);
  assert.equal(_retryTimerPendingForTesting(), true);

  stop();
  assert.equal(_retryTimerPendingForTesting(), false);
  mock.timers.tick(60_000);
  await new Promise((r) => setImmediate(r));
  assert.equal(client.calls.fetch.length, 1);
});

// handleMessage's failure contract: it throws only for a *transient* delivery failure (the
// host unreachable, or answering 5xx/429); every deliberate drop returns normally so the
// cursor moves past it.

test('handleMessage throws when the host is unreachable (transient)', async () => {
  const ctx = makeCtx({ triggerInbound: async () => { throw new Error('ECONNREFUSED'); } });
  await reverseIndex.build(ctx);
  _setClientForTesting(makeFakeClient([]));

  await assert.rejects(() => handleMessage(ctx, msg(50)), /ECONNREFUSED/);
});

test('handleMessage throws on a 5xx from the host (transient)', async () => {
  const ctx = makeCtx({ triggerInbound: async () => new Response('busy', { status: 503 }) });
  await reverseIndex.build(ctx);
  _setClientForTesting(makeFakeClient([]));

  await assert.rejects(() => handleMessage(ctx, msg(51)), /503/);
});

test('handleMessage returns normally on a 404 routing rejection (permanent drop, cursor moves on)', async () => {
  const ctx = makeCtx({
    triggerInbound: async () => new Response(JSON.stringify({ error: 'channel not registered' }), { status: 404 }),
  });
  await reverseIndex.build(ctx);
  _setClientForTesting(makeFakeClient([]));

  await handleMessage(ctx, msg(52));
  assert.equal(ctx.calls.warns.some((w) => w.includes('channel not registered')), true);
});

test('handleMessage returns normally on a 4xx other than 404 (permanent drop)', async () => {
  const ctx = makeCtx({ triggerInbound: async () => new Response('bad payload', { status: 400 }) });
  await reverseIndex.build(ctx);
  _setClientForTesting(makeFakeClient([]));

  await handleMessage(ctx, msg(53));
  assert.equal(ctx.calls.warns.some((w) => w.includes('400')), true);
});
