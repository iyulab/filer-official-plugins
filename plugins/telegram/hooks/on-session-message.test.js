const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('./on-session-message.js');

// The reply to a conversation that came in on Telegram. Filer always passes the reply's text; the plugin never looks a
// session's history up (a panel chat is not relayed, and a host-run session had no history to read).

const SETTINGS = {
  'telegram.botToken': 'test-token',
  'telegram.defaultChatId': '12345',
  'telegram.messageFormat': 'plain',
};

function makeStore() {
  const data = {};
  return { data, get: async (k) => data[k], set: async (k, v) => { data[k] = v; } };
}
function makeCtx() {
  return {
    settings: { get: async (key) => SETTINGS[key] },
    fetch: async () => {
      throw new Error('ctx.fetch must not be called — the reply text arrives in the event');
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

test('sends the reply text the event carries', async () => {
  const ctx = makeCtx();

  await withMockTelegramFetch(async (telegramCalls) => {
    await handler({ channelId: 'default', sessionId: 'sess-2', result: 'Done.' }, ctx);

    assert.equal(telegramCalls.length, 1);
    assert.equal(telegramCalls[0].body.text, 'Done.');
  });
});

// A relay with nothing to say is not a delivered reply: it used to fall back to a history lookup that answered 404 for every
// host-run session and returned quietly, which read as delivered.
test('a relay with no reply text throws, and sends nothing', async () => {
  const ctx = makeCtx();
  await withMockTelegramFetch(async (telegramCalls) => {
    await assert.rejects(handler({ channelId: 'default', sessionId: 's', result: '  ' }, ctx), /no reply text/);
    await assert.rejects(handler({ channelId: 'default', sessionId: 's' }, ctx), /no reply text/);
    assert.equal(telegramCalls.length, 0);
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

// The host reads this hook's outcome as whether an inbound run's reply reached the user: a relay that cannot be made must
// throw, never return quietly (a quiet return read as delivered — the run said Completed with nothing sent).
test('a relay with no chat id throws, and sends nothing', async () => {
  const ctx = makeCtx();
  ctx.settings.get = async (key) => (key === 'telegram.defaultChatId' ? undefined : SETTINGS[key]);
  await withMockTelegramFetch(async (telegramCalls) => {
    await assert.rejects(handler({ channelId: 'default', sessionId: 's', result: 'hi' }, ctx), /chat id is not set/);
    assert.equal(telegramCalls.length, 0);
  });
});

test('a relay the Telegram API refuses throws, and is not recorded as sent', async () => {
  const ctx = makeCtx();
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }) });
  try {
    await assert.rejects(handler({ channelId: 'default', sessionId: 's', result: 'hi' }, ctx), /chat not found/);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(ctx.store.data.messageHistory, undefined);
});

test('a session with no channel is not a relay — nothing is thrown or sent', async () => {
  const ctx = makeCtx();
  ctx.settings.get = async () => undefined;
  await withMockTelegramFetch(async (telegramCalls) => {
    await handler({ sessionId: 's', result: 'hi' }, ctx);
    assert.equal(telegramCalls.length, 0);
  });
});
