const { test } = require('node:test');
const assert = require('node:assert/strict');
const pollingService = require('./polling-service.js');
const onSettingsChanged = require('../hooks/on-settings-changed.js');

// Turning inbound polling on or off in Settings applies at once (it used to wait for the next start of Filer — the switch
// was read only at onRuntimeReady), and a restart ends the old 30 s long poll instead of leaving it open beside the new one.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeCtx(settings) {
  const store = new Map();
  return {
    settings: { get: async (key) => settings[key] },
    store: { get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } },
    listChannels: async () => [],
    channels: { getIntegrationConfig: async () => null },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    toast: () => {},
  };
}

// getUpdates hangs like a long poll until its signal aborts.
function withLongPollFetch(fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = (url, init) => {
    const call = { method: String(url).split('/').pop(), signal: init?.signal };
    calls.push(call);
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    });
  };
  return Promise.resolve(fn(calls)).finally(() => { global.fetch = original; });
}

const CONFIGURED = { 'telegram.botToken': 't', 'telegram.defaultChatId': '1' };

test('start does not poll while inbound polling is off', async () => {
  await withLongPollFetch(async (calls) => {
    await pollingService.start(makeCtx({ ...CONFIGURED, 'telegram.enablePolling': false }));
    await sleep(20);
    assert.equal(calls.length, 0);
    pollingService.stop();
  });
});

test('turning polling off ends the open long poll at once, and nothing polls after', async () => {
  await withLongPollFetch(async (calls) => {
    const settings = { ...CONFIGURED, 'telegram.enablePolling': true };
    const ctx = makeCtx(settings);
    await pollingService.start(ctx);
    await sleep(20);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'getUpdates');

    settings['telegram.enablePolling'] = false;
    await onSettingsChanged({ key: 'telegram.enablePolling', newValue: false }, ctx);
    await sleep(20);
    assert.equal(calls[0].signal.aborted, true, 'the old long poll is aborted');
    assert.equal(calls.length, 1, 'no new poll while off');
  });
});

test('turning polling on starts it without a restart of Filer', async () => {
  await withLongPollFetch(async (calls) => {
    const settings = { ...CONFIGURED, 'telegram.enablePolling': false };
    const ctx = makeCtx(settings);
    await pollingService.start(ctx);
    settings['telegram.enablePolling'] = true;
    await onSettingsChanged({ key: 'telegram.enablePolling', newValue: true }, ctx);
    await sleep(20);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'getUpdates');
    pollingService.stop();
  });
});

test('a new bot token replaces the running poller — one open poll, not two', async () => {
  await withLongPollFetch(async (calls) => {
    const settings = { ...CONFIGURED, 'telegram.enablePolling': true };
    const ctx = makeCtx(settings);
    await pollingService.start(ctx);
    await sleep(20);
    settings['telegram.botToken'] = 't2';
    await onSettingsChanged({ key: 'telegram.botToken', newValue: null }, ctx);
    await sleep(20);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    pollingService.stop();
  });
});

test('a setting the poller does not read leaves it alone', async () => {
  await withLongPollFetch(async (calls) => {
    const ctx = makeCtx({ ...CONFIGURED, 'telegram.enablePolling': true });
    await pollingService.start(ctx);
    await sleep(20);
    await onSettingsChanged({ key: 'telegram.messageFormat', newValue: 'HTML' }, ctx);
    await onSettingsChanged({ key: 'email.enableImapPolling', newValue: true }, ctx);
    await sleep(20);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].signal.aborted, false);
    pollingService.stop();
  });
});
