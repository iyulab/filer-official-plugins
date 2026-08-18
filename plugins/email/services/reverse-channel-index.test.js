const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveFromIndex } = require('./reverse-channel-index.js');

test('resolveFromIndex returns the mapped channel for a known sender', () => {
  const index = new Map([['boss@example.com', 'channel-123']]);
  assert.equal(resolveFromIndex(index, 'boss@example.com'), 'channel-123');
});

test('resolveFromIndex is case-insensitive on the sender address', () => {
  const index = new Map([['boss@example.com', 'channel-123']]);
  assert.equal(resolveFromIndex(index, 'Boss@Example.com'), 'channel-123');
});

test('resolveFromIndex falls back to default for an unknown sender', () => {
  const index = new Map([['boss@example.com', 'channel-123']]);
  assert.equal(resolveFromIndex(index, 'stranger@example.com'), 'default');
});

test('resolveFromIndex falls back to default for an empty index (v1: no UI populates it)', () => {
  const index = new Map();
  assert.equal(resolveFromIndex(index, 'anyone@example.com'), 'default');
});

test('resolveFromIndex falls back to default when fromAddress is missing', () => {
  const index = new Map([['boss@example.com', 'channel-123']]);
  assert.equal(resolveFromIndex(index, undefined), 'default');
});
