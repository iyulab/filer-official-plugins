import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import handler from './send-message.js';

function makeCtx(calls, store) {
  return {
    channels: { getIntegrationConfig: async () => null },
    settings: { get: async key => (key === 'slack.webhookUrl' ? 'https://hooks.slack.example.com/services/xxx' : undefined) },
    store: { get: async k => store.get(k), set: async (k, v) => { store.set(k, v); } },
    viewData: { set: () => {} },
    log: { warn: () => {} },
    fetch: async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, text: async () => 'ok' };
    },
  };
}

// A Slack app's incoming webhook always posts to the channel it was created for and ignores a channel in the payload,
// so the tool must not offer one, send one, or record one in the history as if it had been honoured.
test('send-message posts the text to the webhook without a channel, and the history claims none', async () => {
  const calls = [];
  const store = new Map();
  const result = await handler({ text: 'hello', channel: '#elsewhere' }, makeCtx(calls, store));

  assert.equal(result.success, true);
  assert.deepEqual(calls[0].body, { text: 'hello' });
  assert.equal('channel' in store.get('messageHistory')[0], false);
});

test('the tool schema offers no channel parameter', () => {
  const schema = JSON.parse(readFileSync(new URL('./send-message.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(schema.properties), ['text']);
});

function makeChannelCtx({ channelId, channelWebhook }) {
  const posted = [];
  const store = new Map();
  return {
    posted,
    ctx: {
      channelId,
      settings: { get: async (key) => (key === 'slack.webhookUrl' ? 'https://hooks.example.com/global' : undefined) },
      channels: {
        getIntegrationConfig: async (id, plugin) =>
          id === 'ch-1' && plugin === 'slack' && channelWebhook ? { webhookUrl: channelWebhook } : null,
      },
      // A call here is the old lookup: a session carries no channel id, and the plugin does not declare it.
      session: { getActive: async () => { throw new Error('session.getActive is not declared'); } },
      fetch: async (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return { ok: true, text: async () => '' }; },
      store: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } },
      viewData: { set: () => {} },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    },
  };
}

test('send-message posts to the webhook of the channel the call came from', async () => {
  const { ctx, posted } = makeChannelCtx({ channelId: 'ch-1', channelWebhook: 'https://hooks.example.com/ch-1' });

  await handler({ text: 'hello' }, ctx);

  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, 'https://hooks.example.com/ch-1');
});

test('send-message uses the global webhook for the default channel', async () => {
  const { ctx, posted } = makeChannelCtx({ channelId: 'default' });

  await handler({ text: 'hello' }, ctx);

  assert.equal(posted[0].url, 'https://hooks.example.com/global');
});

test('send-message falls back to the global webhook when the channel has none', async () => {
  const { ctx, posted } = makeChannelCtx({ channelId: 'ch-1' });

  await handler({ text: 'hello' }, ctx);

  assert.equal(posted[0].url, 'https://hooks.example.com/global');
});
