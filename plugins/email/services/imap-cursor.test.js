const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCursor, isAuthFailure } = require('./imap-cursor.js');

test('resolveCursor starts fresh at uidNext - 1 when there is no stored cursor', () => {
  const result = resolveCursor(null, 42, 100);
  assert.deepEqual(result, { uidValidity: 42, lastUid: 99, reset: false });
});

test('resolveCursor keeps the stored cursor when uidValidity matches', () => {
  const stored = { uidValidity: 42, lastUid: 55 };
  const result = resolveCursor(stored, 42, 100);
  assert.deepEqual(result, { uidValidity: 42, lastUid: 55, reset: false });
});

test('resolveCursor resets when uidValidity changed (mailbox recreated / UIDs reused)', () => {
  const stored = { uidValidity: 42, lastUid: 55 };
  const result = resolveCursor(stored, 43, 200);
  assert.deepEqual(result, { uidValidity: 43, lastUid: 199, reset: true });
});

test('isAuthFailure is true for imapflow AuthenticationFailure errors', () => {
  const err = new Error('Invalid credentials');
  err.authenticationFailed = true;
  assert.equal(isAuthFailure(err), true);
});

test('isAuthFailure is false for a plain network error', () => {
  const err = new Error('ECONNRESET');
  assert.equal(isAuthFailure(err), false);
});

test('isAuthFailure is false for undefined or null', () => {
  assert.equal(isAuthFailure(undefined), false);
  assert.equal(isAuthFailure(null), false);
});
