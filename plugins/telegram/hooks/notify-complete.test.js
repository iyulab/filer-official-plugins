const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('./notify-complete.js');

const SETTINGS = {
  'telegram.notifyOnAgentComplete': true,
  'telegram.botToken': 'test-token',
  'telegram.defaultChatId': '12345',
};

function makeCtx() {
  return {
    settings: { get: async key => SETTINGS[key] },
    toast: () => {},
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
      { channelId: 'default', duration: 4200, result: 'Total amount: $1,095 across 4 invoices.' },
      makeCtx(),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.text, '✅ Agent completed (4.2s)\n\nTotal amount: $1,095 across 4 invoices.');
  });
});

test('notify-complete falls back to a placeholder when result is missing', async () => {
  await withMockFetch({ ok: true, result: {} }, async calls => {
    await handler({ channelId: 'default', duration: 0, result: null }, makeCtx());

    assert.equal(calls.length, 1);
    assert.match(calls[0].body.text, /No summary available/);
  });
});
