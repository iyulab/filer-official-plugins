const { test } = require('node:test');
const assert = require('node:assert/strict');

// Inbound mail with a signed-in Microsoft account: the listener connects to the Microsoft 365 IMAP server with a token Filer
// gives for the connection (no IMAP settings), and stops — saying why — when the account must sign in again.

const connections = [];
class FakeImapFlow {
  constructor(options) {
    this.options = options;
    this.handlers = {};
    connections.push(this);
  }
  on(event, cb) { (this.handlers[event] ??= []).push(cb); }
  async connect() {}
  async mailboxOpen() { return { uidValidity: 1n, uidNext: 1 }; }
  fetch() { return (async function* () {})(); }
  async logout() {}
}
const imapflowPath = require.resolve('imapflow');
require.cache[imapflowPath] = { id: imapflowPath, filename: imapflowPath, loaded: true, exports: { ImapFlow: FakeImapFlow } };

const imapService = require('./imap-service.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCtx(getToken) {
  const store = new Map();
  const toasts = [];
  const settings = { 'email.enableImapPolling': true, 'email.provider': 'microsoft' };
  return {
    toasts,
    settings: { get: async (key) => settings[key] },
    store: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } },
    listChannels: async () => [],
    auth: { getToken },
    toast: (t) => toasts.push(t),
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
}

test('a Microsoft account connects to Microsoft 365 with a token, not a password', async () => {
  connections.length = 0;
  const ctx = makeCtx(async () => ({ accessToken: 'tok', account: 'person@example.com', expiresAt: '' }));

  await imapService.start(ctx);
  await sleep(50);
  imapService.stop();

  assert.equal(connections.length, 1);
  const { host, port, secure, auth } = connections[0].options;
  assert.deepEqual({ host, port, secure }, { host: 'outlook.office365.com', port: 993, secure: true });
  assert.deepEqual(auth, { user: 'person@example.com', accessToken: 'tok' });
});

test('an account that must sign in again stops the listener and says so', async () => {
  connections.length = 0;
  const ctx = makeCtx(async () => {
    throw Object.assign(new Error('The Microsoft account needs to sign in again.'), { code: 'microsoft_sign_in_needed' });
  });

  await imapService.start(ctx);
  await sleep(50);

  assert.equal(connections.length, 0, 'no connection without a token');
  assert.equal(ctx.toasts.length, 1);
  assert.match(ctx.toasts[0].message, /sign in with Microsoft again/);
  imapService.stop();
});
