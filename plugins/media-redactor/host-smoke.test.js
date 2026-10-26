'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipReason, runHost, solidPng } = require('../../shared/host-smoke.js');

const exe = path.join(__dirname, 'bin', 'MediaRedactor.PluginHost.exe');

// The published (NativeAOT) host, driven over its stdio protocol. See shared/host-smoke.js for why.
test('the published host redacts a region of an image', { skip: skipReason(exe) ?? false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-redactor-smoke-'));
  try {
    const source = path.join(dir, 'in.png');
    fs.writeFileSync(source, solidPng(320, 200, [30, 160, 90]));
    const outputPath = path.join(dir, 'out.png');

    const reply = await runHost(exe, 'redact_region', { path: source, x: 20, y: 20, width: 100, height: 60, outputPath });

    assert.equal(reply.error, undefined);
    assert.equal(reply.result.success, true);
    assert.ok(fs.statSync(outputPath).size > 0, 'the redacted image was written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the published host asks the caller\'s model for a region and writes what it answers', { skip: skipReason(exe) ?? false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-redactor-smoke-'));
  try {
    const source = path.join(dir, 'in.png');
    fs.writeFileSync(source, solidPng(320, 200, [200, 200, 40]));
    const asked = [];

    const reply = await runHost(exe, 'detect_region', { path: source, description: 'the top-left corner' }, (method, params) => {
      asked.push(method);
      assert.ok(params.imageUrls[0].startsWith('data:image/png;base64,'), 'the frame travels as a data URL');
      return 'The region is {"x": 10, "y": 12, "width": 80, "height": 40}.';
    });

    assert.equal(reply.error, undefined);
    assert.deepEqual(asked, ['ai.complete']);
    assert.ok(reply.result, 'a result came back');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
