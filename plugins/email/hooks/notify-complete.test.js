import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from './notify-complete.js';

const SETTINGS = {
  'email.notifyOnAgentComplete': true,
  'email.fromAddress': 'agent@example.com',
  'email.defaultTo': 'user@example.com',
  'email.provider': 'resend',
  'email.resendApiKey': 'test-key',
};

function makeCtx(calls) {
  return {
    settings: { get: async key => SETTINGS[key] },
    toast: () => {},
    log: { error: () => {} },
    fetch: async (url, init) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
      return { ok: true, json: async () => ({}) };
    },
  };
}

test('notify-complete sends the real turn result text, not the broken event.result.summary fallback', async () => {
  const calls = [];
  await handler({ duration: 5000, result: 'Total amount: $1,095 across 4 invoices.' }, makeCtx(calls));

  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Total amount: \$1,095 across 4 invoices\./);
});

test('notify-complete falls back to a placeholder when result is missing', async () => {
  const calls = [];
  await handler({ duration: 0, result: null }, makeCtx(calls));

  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Task completed/);
});
