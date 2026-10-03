const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('./notify-complete.js');

const SETTINGS = {
  'telegram.notifyOnAgentComplete': true,
  'telegram.botToken': 'test-token',
  'telegram.defaultChatId': '12345',
};

function makeStore() {
  const data = {};
  return { data, get: async (k) => data[k], set: async (k, v) => { data[k] = v; } };
}
function makeCtx() {
  return {
    settings: { get: async key => SETTINGS[key] },
    toast: () => {},
    store: makeStore(),
    viewData: { set: () => {} },
  };
}

async function withMockFetch(responseBody, fn) {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
    return { json: async () => responseBody };
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = originalFetch;
  }
}

test('notify-complete sends the real turn result text, not the broken event.result.summary fallback', async () => {
  await withMockFetch({ ok: true, result: {} }, async calls => {
    await handler(
      { channelId: 'default', duration: 4200, result: 'Total amount: $1,095 across 4 invoices.', outcome: 'completed' },
      makeCtx(),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.text, '✅ Agent completed (4.2s)\n\nTotal amount: $1,095 across 4 invoices.');
  });
});

test('notify-complete records the message it sent in the plugin history', async () => {
  const ctx = makeCtx();
  await withMockFetch({ ok: true, result: {} }, async () => {
    await handler({ channelId: 'default', duration: 1000, result: 'Done.', outcome: 'completed' }, ctx);
  });
  const history = ctx.store.data.messageHistory;
  assert.equal(history.length, 1);
  assert.equal(history[0].direction, 'out');
  assert.equal(history[0].chatId, '12345');
  assert.match(history[0].message, /Agent completed/);
});

test('notify-complete records nothing when Telegram refuses the message', async () => {
  const ctx = makeCtx();
  await withMockFetch({ ok: false, description: 'Bad Request: chat not found' }, async () => {
    await handler({ channelId: 'default', duration: 1000, result: 'Done.' }, ctx);
  });
  assert.equal(ctx.store.data.messageHistory, undefined);
});

test('notify-complete falls back to a placeholder when result is missing', async () => {
  await withMockFetch({ ok: true, result: {} }, async calls => {
    await handler({ channelId: 'default', duration: 0, result: null }, makeCtx());

    assert.equal(calls.length, 1);
    assert.match(calls[0].body.text, /No summary available/);
  });
});

// The notice used to say "✅ Agent completed" for every run, a failed one included — the event now says how the run ended.
test('notify-complete says a failed run failed, with the reason and not the raw error text', async () => {
  await withMockFetch({ ok: true, result: {} }, async calls => {
    await handler(
      { channelId: 'default', duration: 3000, result: '[error] HttpRequestException: 502', outcome: 'failed', reason: 'The model service did not answer.' },
      makeCtx(),
    );

    assert.equal(calls[0].body.text, '❌ Agent failed (3.0s)\n\nThe model service did not answer.');
  });
});

test('notify-complete says an unfulfilled run was not fully done, with why and what it did', async () => {
  await withMockFetch({ ok: true, result: {} }, async calls => {
    await handler(
      { channelId: 'default', duration: 2000, result: 'Wrote 2 of 3 summaries.', outcome: 'unfulfilled', reason: 'One output was not written.' },
      makeCtx(),
    );

    assert.equal(calls[0].body.text, '⚠️ Agent finished without doing everything asked (2.0s)\n\nOne output was not written.\n\nWrote 2 of 3 summaries.');
  });
});

test('notify-complete does not claim success when the event does not say how the run ended', async () => {
  await withMockFetch({ ok: true, result: {} }, async calls => {
    await handler({ channelId: 'default', duration: 1000, result: 'Done.' }, makeCtx());

    assert.match(calls[0].body.text, /^Agent finished \(1\.0s\)/);
  });
});
