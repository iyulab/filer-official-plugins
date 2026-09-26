const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('./on-session-message.js');

// HD-91 regression guard: a UI-chat-panel session's transcript lookup must route through
// ctx.getSessionHistory, never ctx.fetch — see plugin-context.ts's HD-91 comments.

const SETTINGS = {
  'telegram.botToken': 'test-token',
  'telegram.defaultChatId': '12345',
  'telegram.messageFormat': 'plain',
};

function makeStore() {
  const data = {};
  return { data, get: async (k) => data[k], set: async (k, v) => { data[k] = v; } };
}
function makeCtx({ history } = {}) {
  const calls = { fetch: [], getSessionHistory: [] };
  return {
    calls,
    settings: { get: async (key) => SETTINGS[key] },
    fetch: async (...args) => {
      calls.fetch.push(args);
      throw new Error('ctx.fetch must not be called — use ctx.getSessionHistory');
    },
    getSessionHistory: async (sessionId) => {
      calls.getSessionHistory.push(sessionId);
      return history;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    store: makeStore(),
    viewData: { set: () => {} },
  };
}

async function withMockTelegramFetch(fn) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = originalFetch;
  }
}

test('relays a UI-chat-panel session (no event.result) via ctx.getSessionHistory, not ctx.fetch', async () => {
  const ctx = makeCtx({
    history: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Total amount: $1,095' },
    ],
  });

  await withMockTelegramFetch(async (telegramCalls) => {
    await handler({ channelId: 'default', sessionId: 'sess-1' }, ctx);

    assert.equal(ctx.calls.fetch.length, 0);
    assert.deepEqual(ctx.calls.getSessionHistory, ['sess-1']);
    assert.equal(telegramCalls.length, 1);
    assert.equal(telegramCalls[0].body.text, 'Total amount: $1,095');
  });
});

test('skips the fetch/getSessionHistory call entirely when the event already carries result (host-triggered path)', async () => {
  const ctx = makeCtx();

  await withMockTelegramFetch(async (telegramCalls) => {
    await handler({ channelId: 'default', sessionId: 'sess-2', result: 'Done.' }, ctx);

    assert.equal(ctx.calls.getSessionHistory.length, 0);
    assert.equal(telegramCalls[0].body.text, 'Done.');
  });
});

test('a relayed reply is recorded in the plugin history (the reply to an inbound message, not only tool sends)', async () => {
  const ctx = makeCtx();
  await withMockTelegramFetch(async () => {
    await handler({ channelId: 'default', sessionId: 'sess-3', result: 'The total is 1,095.' }, ctx);
  });
  const history = ctx.store.data.messageHistory;
  assert.equal(history.length, 1);
  assert.equal(history[0].direction, 'out');
  assert.equal(history[0].message, 'The total is 1,095.');
  assert.equal(history[0].channelId, 'default');
});
