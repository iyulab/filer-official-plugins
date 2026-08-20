const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveFromIndex, isAllowed, parseAllowlist } = require('./reverse-channel-index.js');

test('resolveFromIndex returns the mapped channel for a known sender regardless of the allowlist', () => {
  const index = new Map([['boss@example.com', 'channel-123']]);
  assert.equal(resolveFromIndex(index, new Set(), 'boss@example.com'), 'channel-123');
});

test('resolveFromIndex is case-insensitive on the sender address', () => {
  const index = new Map([['boss@example.com', 'channel-123']]);
  assert.equal(resolveFromIndex(index, new Set(), 'Boss@Example.com'), 'channel-123');
});

test('resolveFromIndex falls back to default for an unmapped sender on the allowlist', () => {
  const index = new Map([['boss@example.com', 'channel-123']]);
  const allowlist = new Set(['stranger@example.com']);
  assert.equal(resolveFromIndex(index, allowlist, 'stranger@example.com'), 'default');
});

test('resolveFromIndex rejects an unmapped sender not on the allowlist', () => {
  const index = new Map([['boss@example.com', 'channel-123']]);
  const allowlist = new Set(['stranger@example.com']);
  assert.equal(resolveFromIndex(index, allowlist, 'nobody@example.com'), null);
});

test('resolveFromIndex rejects every unmapped sender for an empty allowlist (secure by default)', () => {
  const index = new Map();
  assert.equal(resolveFromIndex(index, new Set(), 'anyone@example.com'), null);
});

test('resolveFromIndex rejects when fromAddress is missing, even with a non-empty allowlist', () => {
  const index = new Map([['boss@example.com', 'channel-123']]);
  const allowlist = new Set(['@example.com']);
  assert.equal(resolveFromIndex(index, allowlist, undefined), null);
});

test('resolveFromIndex admits an unmapped sender via a domain-wildcard allowlist entry', () => {
  const index = new Map();
  const allowlist = new Set(['@example.com']);
  assert.equal(resolveFromIndex(index, allowlist, 'anyone@example.com'), 'default');
});

test('isAllowed matches an exact address entry', () => {
  assert.equal(isAllowed(new Set(['alice@example.com']), 'alice@example.com'), true);
  assert.equal(isAllowed(new Set(['alice@example.com']), 'bob@example.com'), false);
});

test('isAllowed matches a domain-wildcard entry against any address on that domain', () => {
  const allowlist = new Set(['@example.com']);
  assert.equal(isAllowed(allowlist, 'alice@example.com'), true);
  assert.equal(isAllowed(allowlist, 'bob@example.com'), true);
  assert.equal(isAllowed(allowlist, 'alice@other.com'), false);
});

test('isAllowed does not let a bare domain entry (no @ prefix) match anything', () => {
  // "example.com" without a leading '@' is a malformed/no-op entry, not a domain wildcard —
  // deliberately not treated as one, to keep the wildcard syntax unambiguous.
  const allowlist = new Set(['example.com']);
  assert.equal(isAllowed(allowlist, 'alice@example.com'), false);
});

test('isAllowed returns false for an address with no @ at all', () => {
  assert.equal(isAllowed(new Set(['@example.com']), 'not-an-email'), false);
});

test('parseAllowlist splits, trims, and lowercases comma-separated entries', () => {
  const result = parseAllowlist(' Alice@Example.com ,  @Company.com,, ');
  assert.deepEqual([...result].sort(), ['@company.com', 'alice@example.com']);
});

test('parseAllowlist returns an empty set for undefined or empty input', () => {
  assert.deepEqual(parseAllowlist(undefined), new Set());
  assert.deepEqual(parseAllowlist(''), new Set());
});
