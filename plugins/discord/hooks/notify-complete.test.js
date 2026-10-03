import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from './notify-complete.js';

const SETTINGS = {
  'discord.notifyOnAgentComplete': true,
  'discord.webhookUrl': 'https://discord.example.com/webhook',
  'discord.username': 'Filer',
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
  assert.equal(calls[0].body.embeds[0].description, 'Total amount: $1,095 across 4 invoices.');
});

test('notify-complete falls back to a placeholder when result is missing', async () => {
  const calls = [];
  await handler({ duration: 0, result: null }, makeCtx(calls));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.embeds[0].description, 'Task completed');
});

test('notify-complete marks a failed run as failed, with the reason', async () => {
  const calls = [];
  await handler({ duration: 3000, result: '[error] boom', outcome: 'failed', reason: 'The model service did not answer.' }, makeCtx(calls));

  const embed = calls[0].body.embeds[0];
  assert.equal(embed.title, 'Agent Task Failed');
  assert.equal(embed.description, 'The model service did not answer.');
  assert.notEqual(embed.color, 3066993, 'a failure is not drawn in the success colour');
});

test('notify-complete titles a completed run complete and an unfulfilled one not fully done', async () => {
  const calls = [];
  await handler({ duration: 1000, result: 'Done.', outcome: 'completed' }, makeCtx(calls));
  await handler({ duration: 1000, result: 'Wrote 2 of 3.', outcome: 'unfulfilled', reason: 'One output was not written.' }, makeCtx(calls));

  assert.equal(calls[0].body.embeds[0].title, 'Agent Task Complete');
  assert.equal(calls[1].body.embeds[0].title, 'Agent Task Not Fully Done');
  assert.equal(calls[1].body.embeds[0].description, 'One output was not written.\n\nWrote 2 of 3.');
});
