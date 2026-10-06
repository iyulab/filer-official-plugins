const { test } = require('node:test');
const assert = require('node:assert/strict');

// A settings change restarts the IMAP listener (on-settings-changed.js). The loop from before the restart must end when its
// connection closes — not see `isRunning` true again (the new start set it) and reconnect beside the new loop.

const connections = [];
class FakeImapFlow {
  constructor(options) {
    this.options = options;
    this.handlers = {};
    this.closed = false;
    connections.push(this);
  }
  on(event, cb) { (this.handlers[event] ??= []).push(cb); }
  async connect() {}
  async mailboxOpen() { return { uidValidity: 1n, uidNext: 1 }; }
  fetch() { return (async function* () {})(); }
  // A real logout is a round trip: 'close' comes after the new start() has already set isRunning again — the window the
  // old loop must not mistake for "still mine".
  async logout() {
    if (this.closed) return;
    this.closed = true;
    setTimeout(() => { for (const cb of this.handlers.close ?? []) cb(); }, 50);
  }
}
const imapflowPath = require.resolve('imapflow');
require.cache[imapflowPath] = { id: imapflowPath, filename: imapflowPath, loaded: true, exports: { ImapFlow: FakeImapFlow } };

const imapService = require('./imap-service.js');
const onSettingsChanged = require('../hooks/on-settings-changed.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCtx(settings) {
  const store = new Map();
  return {
    settings: { get: async (key) => settings[key] },
    store: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } },
    listChannels: async () => [],
    channels: { getIntegrationConfig: async () => null },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    toast: () => {},
  };
}

const ENABLED = {
  'email.enableImapPolling': true,
  'email.imapHost': 'imap.example.com',
  'email.imapUser': 'u',
  'email.imapPassword': 'p',
};

test('a restart leaves exactly one connection — the old loop does not reconnect', async () => {
  const settings = { ...ENABLED };
  const ctx = makeCtx(settings);
  await imapService.start(ctx);
  await sleep(20);
  assert.equal(connections.length, 1);

  settings['email.imapUser'] = 'u2';
  await onSettingsChanged({ key: 'email.imapUser', newValue: 'u2' }, ctx);
  await sleep(20);
  assert.equal(connections.length, 2);
  assert.equal(connections[0].closed, true);
  assert.equal(connections[1].options.auth.user, 'u2', 'the new loop reads the new setting');

  // The old loop's reconnect would come after its 2 s backoff.
  await sleep(2500);
  assert.equal(connections.length, 2, 'no reconnect from the loop before the restart');

  imapService.stop();
  await sleep(20);
  assert.equal(connections[1].closed, true);
});

test('turning inbound mail off stops the listener at once', async () => {
  connections.length = 0;
  const settings = { ...ENABLED };
  const ctx = makeCtx(settings);
  await imapService.start(ctx);
  await sleep(20);
  settings['email.enableImapPolling'] = false;
  await onSettingsChanged({ key: 'email.enableImapPolling', newValue: false }, ctx);
  await sleep(2500);
  assert.equal(connections.length, 1);
  assert.equal(connections[0].closed, true);
});
