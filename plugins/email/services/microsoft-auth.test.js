const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const microsoftAuth = require('./microsoft-auth.js');

test('the XOAUTH2 string is user, then the bearer token, separated by ^A and ended by two', () => {
  const decoded = Buffer.from(microsoftAuth.xoauth2('person@example.com', 'tok123'), 'base64').toString('utf8');
  assert.equal(decoded, 'user=person@example.com\x01auth=Bearer tok123\x01\x01');
});

test('a token is asked for the protocol\'s own scope, and the account becomes the user', async () => {
  const asked = [];
  const ctx = {
    auth: {
      getToken: async (provider, scopes) => {
        asked.push([provider, scopes]);
        return { accessToken: 'tok', account: 'person@example.com', expiresAt: '2026-10-25T01:00:00Z' };
      },
    },
  };
  assert.deepEqual(await microsoftAuth.microsoftToken(ctx, 'smtp'), { user: 'person@example.com', accessToken: 'tok' });
  assert.deepEqual(await microsoftAuth.microsoftToken(ctx, 'imap'), { user: 'person@example.com', accessToken: 'tok' });
  assert.deepEqual(asked, [
    ['microsoft', ['https://outlook.office.com/SMTP.Send']],
    ['microsoft', ['https://outlook.office.com/IMAP.AccessAsUser.All']],
  ]);
});

test('a Filer without sign-in says so, as a sign-in that is needed', async () => {
  await assert.rejects(() => microsoftAuth.microsoftToken({}, 'imap'), (err) => {
    assert.equal(microsoftAuth.needsSignIn(err), true);
    assert.match(err.message, /newer version of Filer/);
    return true;
  });
});

test('the manifest declares exactly the two scopes the code asks for', () => {
  const manifest = require('../filer-plugin.json');
  assert.deepEqual([...manifest.permissions.auth.microsoft].sort(),
    [microsoftAuth.MICROSOFT.imap.scope, microsoftAuth.MICROSOFT.smtp.scope].sort());
  assert.ok(manifest.contributes.settings['email.provider'].enum.includes('microsoft'));
});

test('a server that offers no encryption never receives the token', async () => {
  // A plain SMTP server: greets, answers EHLO without STARTTLS, and records everything it receives.
  const received = [];
  const server = net.createServer((socket) => {
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (d) => {
      received.push(d.toString());
      if (d.toString().startsWith('EHLO')) socket.write('250-test\r\n250 AUTH LOGIN XOAUTH2\r\n');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { default: sendEmail } = await import('../tools/send-email.js');
    const settings = { 'email.provider': 'microsoft', 'email.defaultTo': 'someone@example.com' };
    const ctx = {
      settings: { get: async (k) => settings[k] },
      auth: { getToken: async () => ({ accessToken: 'secret-token', account: 'person@example.com', expiresAt: '' }) },
      store: { get: async () => undefined, set: async () => {} },
      viewData: { set: () => {} },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    // Point the Microsoft server at the local test server for this call.
    const original = { ...microsoftAuth.MICROSOFT.smtp };
    Object.assign(microsoftAuth.MICROSOFT.smtp, { host: '127.0.0.1', port });
    try {
      await assert.rejects(() => sendEmail({ subject: 's', body: 'b' }, ctx), /did not offer an encrypted connection/);
    } finally {
      Object.assign(microsoftAuth.MICROSOFT.smtp, original);
    }
    assert.ok(!received.join('').includes('secret-token'), 'the token must not cross an unencrypted connection');
    assert.ok(!received.join('').includes('XOAUTH2'), 'no AUTH command on an unencrypted connection');
  } finally {
    server.close();
  }
});
