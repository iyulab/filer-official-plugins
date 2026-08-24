import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from './on-execution-completed.js';

const SETTINGS = {
  'slack.notifyOnAgentComplete': true,
  'slack.webhookUrl': 'https://hooks.slack.example.com/services/xxx',
};

function makeCtx(calls) {
  return {
    settings: { get: async key => SETTINGS[key] },
    channels: { getIntegrationConfig: async () => null },
    log: { error: () => {} },
    fetch: async (url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  };
}

test('on-execution-completed sends the real turn result text, not a fabricated status/agentName line', async () => {
  const calls = [];
  await handler({ channelId: 'default', duration: 4200, result: 'Total amount: $1,095 across 4 invoices.' }, makeCtx(calls));

  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Total amount: \$1,095 across 4 invoices\./);
  assert.match(calls[0].body.text, /4s/);
});

test('on-execution-completed falls back to a placeholder when result is missing', async () => {
  const calls = [];
  await handler({ channelId: 'default', duration: 0, result: null }, makeCtx(calls));

  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Task completed/);
});

test('on-execution-completed does nothing when notifyOnAgentComplete is off', async () => {
  const calls = [];
  const ctx = makeCtx(calls);
  ctx.settings.get = async key => (key === 'slack.notifyOnAgentComplete' ? false : SETTINGS[key]);
  await handler({ channelId: 'default', duration: 1000, result: 'hello' }, ctx);

  assert.equal(calls.length, 0);
});
