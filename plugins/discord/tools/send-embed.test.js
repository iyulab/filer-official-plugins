import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from './send-embed.js';

function makeCtx({ channelId, channelWebhook }) {
  const posted = [];
  const store = new Map();
  return {
    posted,
    ctx: {
      channelId,
      settings: { get: async (key) => (key === 'discord.webhookUrl' ? 'https://hooks.example.com/global' : undefined) },
      channels: {
        getIntegrationConfig: async (id, plugin) =>
          id === 'ch-1' && plugin === 'discord' && channelWebhook ? { webhookUrl: channelWebhook } : null,
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

test('send-embed posts to the webhook of the channel the call came from', async () => {
  const { ctx, posted } = makeCtx({ channelId: 'ch-1', channelWebhook: 'https://hooks.example.com/ch-1' });

  await handler({ title: 'hello' }, ctx);

  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, 'https://hooks.example.com/ch-1');
});

test('send-embed uses the global webhook for the default channel', async () => {
  const { ctx, posted } = makeCtx({ channelId: 'default' });

  await handler({ title: 'hello' }, ctx);

  assert.equal(posted[0].url, 'https://hooks.example.com/global');
});

test('send-embed falls back to the global webhook when the channel has none', async () => {
  const { ctx, posted } = makeCtx({ channelId: 'ch-1' });

  await handler({ title: 'hello' }, ctx);

  assert.equal(posted[0].url, 'https://hooks.example.com/global');
});
