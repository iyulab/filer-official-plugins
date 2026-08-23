const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findTextPart,
  findAttachmentParts,
  isBlockedAttachmentType,
  exceedsDownloadSizeCeiling,
} = require('./mime-body.js');

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

// ── findAttachmentParts (HD-53 step 1: metadata; HD-56 step 2: `part` added
// so a caller can download the actual bytes) ──

test('findAttachmentParts returns empty for a simple text-only message', () => {
  const structure = { type: 'text/plain' };
  assert.deepEqual(findAttachmentParts(structure), []);
});

test('findAttachmentParts finds a single application/pdf attachment alongside the body', () => {
  const body = { type: 'text/plain', part: '1' };
  const pdf = {
    type: 'application/pdf',
    disposition: 'attachment',
    dispositionParameters: { filename: 'invoice.pdf' },
    part: '2',
    size: 12345,
  };
  const structure = { type: 'multipart/mixed', childNodes: [body, pdf] };

  assert.deepEqual(findAttachmentParts(structure), [
    { filename: 'invoice.pdf', type: 'application/pdf', size: 12345, part: '2' },
  ]);
});

test('findAttachmentParts finds multiple attachments', () => {
  const body = { type: 'text/plain', part: '1' };
  const pdf = {
    type: 'application/pdf',
    disposition: 'attachment',
    dispositionParameters: { filename: 'invoice.pdf' },
    part: '2',
  };
  const png = {
    type: 'image/png',
    disposition: 'attachment',
    dispositionParameters: { filename: 'screenshot.png' },
    part: '3',
  };
  const structure = { type: 'multipart/mixed', childNodes: [body, pdf, png] };

  assert.deepEqual(
    findAttachmentParts(structure).map((a) => a.filename),
    ['invoice.pdf', 'screenshot.png']
  );
});

test('findAttachmentParts falls back to the Content-Type name parameter when no disposition filename exists', () => {
  const pdf = {
    type: 'application/pdf',
    disposition: 'attachment',
    parameters: { name: 'contract.pdf' },
    part: '2',
  };
  const structure = { type: 'multipart/mixed', childNodes: [pdf] };

  assert.equal(findAttachmentParts(structure)[0].filename, 'contract.pdf');
});

test('findAttachmentParts falls back to a part-based placeholder when no filename exists anywhere', () => {
  const pdf = { type: 'application/pdf', disposition: 'attachment', part: '2' };
  const structure = { type: 'multipart/mixed', childNodes: [pdf] };

  assert.equal(findAttachmentParts(structure)[0].filename, 'part-2');
});

test('findAttachmentParts treats a text/plain part with disposition:attachment as an attachment, not the body', () => {
  // Mirrors findTextPart's own sibling test: the same node findTextPart
  // skips as the body must show up here as a real attachment.
  const attachment = { type: 'text/plain', disposition: 'attachment', dispositionParameters: { filename: 'notes.txt' }, part: '1' };
  const body = { type: 'text/plain', part: '2' };
  const structure = { type: 'multipart/mixed', childNodes: [attachment, body] };

  assert.deepEqual(
    findAttachmentParts(structure).map((a) => a.filename),
    ['notes.txt']
  );
});

test('findAttachmentParts does not collect an inline image as an attachment', () => {
  const inlineImage = { type: 'image/png', disposition: 'inline', part: '2' };
  const structure = { type: 'multipart/mixed', childNodes: [{ type: 'text/plain', part: '1' }, inlineImage] };

  assert.deepEqual(findAttachmentParts(structure), []);
});

test('findAttachmentParts does not collect a multipart container itself, only its leaf children', () => {
  const pdf = { type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' }, part: '2.1' };
  const nested = { type: 'multipart/mixed', disposition: 'attachment', part: '2', childNodes: [pdf] };
  const structure = { type: 'multipart/mixed', childNodes: [{ type: 'text/plain', part: '1' }, nested] };

  assert.deepEqual(
    findAttachmentParts(structure).map((a) => a.filename),
    ['a.pdf']
  );
});

test('findAttachmentParts returns empty for an empty/undefined structure', () => {
  assert.deepEqual(findAttachmentParts(undefined), []);
  assert.deepEqual(findAttachmentParts(null), []);
});

test('findAttachmentParts includes part so a caller can download it', () => {
  const pdf = { type: 'application/pdf', disposition: 'attachment', part: '2' };
  const structure = { type: 'multipart/mixed', childNodes: [pdf] };

  assert.equal(findAttachmentParts(structure)[0].part, '2');
});

// ── isBlockedAttachmentType / exceedsDownloadSizeCeiling (HD-56 step 2:
// client-side pre-filters — the host is the authoritative check) ──

test('isBlockedAttachmentType blocks each owner-decided script/executable extension', () => {
  for (const ext of ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.js']) {
    assert.equal(isBlockedAttachmentType(`payload${ext}`), true, ext);
  }
});

test('isBlockedAttachmentType is case-insensitive', () => {
  assert.equal(isBlockedAttachmentType('payload.EXE'), true);
});

test('isBlockedAttachmentType allows ordinary document/image types', () => {
  assert.equal(isBlockedAttachmentType('invoice.pdf'), false);
  assert.equal(isBlockedAttachmentType('screenshot.png'), false);
});

test('isBlockedAttachmentType allows a filename with no extension at all', () => {
  assert.equal(isBlockedAttachmentType('README'), false);
});

test('exceedsDownloadSizeCeiling is false for sizes at or under the ceiling', () => {
  assert.equal(exceedsDownloadSizeCeiling(100 * 1024 * 1024), false);
  assert.equal(exceedsDownloadSizeCeiling(1024), false);
});

test('exceedsDownloadSizeCeiling is true for a size over the ceiling', () => {
  assert.equal(exceedsDownloadSizeCeiling(100 * 1024 * 1024 + 1), true);
});

test('exceedsDownloadSizeCeiling is false when size is unknown (undefined)', () => {
  // bodyStructure doesn't always report a size — treat unknown as "let it
  // through the client pre-filter" since the host re-checks anyway.
  assert.equal(exceedsDownloadSizeCeiling(undefined), false);
});
