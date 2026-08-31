const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { handleMessage, _setClientForTesting } = require('./imap-service.js');
const reverseIndex = require('./reverse-channel-index.js');

// HD-91 regression guard (cycle-647 follow-through): handleMessage must route inbound email
// through ctx.triggerInbound (a fixed, non-SSRF-checked host call) — never ctx.fetch, which
// unconditionally denies the localhost/127.0.0.1 host this call always targets (see
// plugin-context.ts / plugin-secure-context.ts's HD-91 comments).

function makeCtx({ triggerInboundResponse } = {}) {
  const calls = { triggerInbound: [], fetch: [] };
  return {
    calls,
    settings: {
      get: async (key) => (key === 'email.senderAllowlist' ? 'sender@example.com' : undefined),
    },
    listChannels: async () => [],
    channels: { getIntegrationConfig: async () => null },
    fetch: async (...args) => {
      calls.fetch.push(args);
      throw new Error('ctx.fetch must not be called for inbound routing — use ctx.triggerInbound');
    },
    triggerInbound: async (payload) => {
      calls.triggerInbound.push(payload);
      return triggerInboundResponse ?? new Response(null, { status: 202 });
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

function makeFakeClient(bodyText) {
  return {
    // handleMessage -> downloadTextBody: with no bodyStructure, this is called with
    // (uid, undefined, {uid:true}) and must return { content: <readable stream> }.
    download: async () => ({ content: Readable.from([bodyText]) }),
  };
}

test('handleMessage routes an allowlisted sender through ctx.triggerInbound with the correct payload', async () => {
  const ctx = makeCtx();
  await reverseIndex.build(ctx);
  _setClientForTesting(makeFakeClient('What is the total amount in invoice-aug.csv?'));

  await handleMessage(ctx, {
    uid: 42,
    envelope: { from: [{ address: 'sender@example.com' }], messageId: 'msg-42' },
    // No bodyStructure -> downloadTextBody falls to the raw-message-source branch,
    // no MIME fixtures needed; attachmentMetas is [] since message.bodyStructure is falsy.
  });

  assert.equal(ctx.calls.fetch.length, 0);
  assert.equal(ctx.calls.triggerInbound.length, 1);
  assert.deepEqual(ctx.calls.triggerInbound[0], {
    channelId: 'default',
    sourcePlugin: 'email',
    messageId: 'msg-42',
    content: 'What is the total amount in invoice-aug.csv?',
  });
});

test('handleMessage drops a message from a sender not on the allowlist without calling triggerInbound or fetch', async () => {
  const ctx = makeCtx();
  await reverseIndex.build(ctx);
  _setClientForTesting(makeFakeClient('should never be read'));

  await handleMessage(ctx, {
    uid: 43,
    envelope: { from: [{ address: 'stranger@unknown.com' }], messageId: 'msg-43' },
  });

  assert.equal(ctx.calls.triggerInbound.length, 0);
  assert.equal(ctx.calls.fetch.length, 0);
});

test('handleMessage falls back to `email-${uid}` when the envelope has no messageId', async () => {
  const ctx = makeCtx();
  await reverseIndex.build(ctx);
  _setClientForTesting(makeFakeClient('hi'));

  await handleMessage(ctx, {
    uid: 44,
    envelope: { from: [{ address: 'sender@example.com' }] },
  });

  assert.equal(ctx.calls.triggerInbound[0].messageId, 'email-44');
});
