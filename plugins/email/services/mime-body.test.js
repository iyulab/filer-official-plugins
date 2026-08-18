const test = require('node:test');
const assert = require('node:assert/strict');
const { findTextPart } = require('./mime-body.js');

test('findTextPart returns the text/plain part when the message is a simple text body', () => {
  const structure = { type: 'text/plain' };
  const result = findTextPart(structure);
  assert.deepEqual(result, { node: structure, type: 'text/plain' });
});

test('findTextPart skips a text/plain attachment and finds the real body deeper in the tree', () => {
  const attachment = { type: 'text/plain', disposition: 'attachment', part: '1' };
  const body = { type: 'text/plain', part: '2' };
  const structure = { type: 'multipart/mixed', childNodes: [attachment, body] };
  const result = findTextPart(structure);
  assert.equal(result.node, body, 'the attachment must not be mistaken for the message body');
});

test('findTextPart accepts a part with an explicit inline disposition', () => {
  const body = { type: 'text/plain', disposition: 'inline' };
  const result = findTextPart(body);
  assert.deepEqual(result, { node: body, type: 'text/plain' });
});

test('findTextPart falls back to text/html when no eligible text/plain part exists', () => {
  const attachment = { type: 'text/plain', disposition: 'attachment' };
  const html = { type: 'text/html' };
  const structure = { type: 'multipart/mixed', childNodes: [attachment, html] };
  const result = findTextPart(structure);
  assert.deepEqual(result, { node: html, type: 'text/html' });
});

test('findTextPart skips a text/html attachment too, not just text/plain', () => {
  const htmlAttachment = { type: 'text/html', disposition: 'attachment' };
  const structure = { type: 'multipart/mixed', childNodes: [htmlAttachment] };
  assert.equal(findTextPart(structure), null);
});

test('findTextPart returns null when no text part exists anywhere', () => {
  const structure = { type: 'multipart/mixed', childNodes: [{ type: 'application/pdf' }] };
  assert.equal(findTextPart(structure), null);
});

test('findTextPart returns null for an empty/undefined structure', () => {
  assert.equal(findTextPart(undefined), null);
  assert.equal(findTextPart(null), null);
});
