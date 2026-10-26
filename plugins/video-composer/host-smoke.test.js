'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipReason, runHost, solidPng } = require('../../shared/host-smoke.js');

const exe = path.join(__dirname, 'bin', 'VideoComposer.PluginHost.exe');

// The published (NativeAOT) host, driven over its stdio protocol. See shared/host-smoke.js for why.
test('the published host composes a captioned video with title and outro cards', { skip: skipReason(exe) ?? false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-composer-smoke-'));
  try {
    const images = ['a.png', 'b.png'].map((name, i) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, solidPng(640, 360, i === 0 ? [70, 130, 180] : [255, 99, 71]));
      return file;
    });
    const outputPath = path.join(dir, 'out.mp4');

    const reply = await runHost(exe, 'compose_video', {
      imagePaths: images,
      captions: ['First scene', '두 번째 장면'],
      sceneDurationSeconds: 1.5,
      outputPath,
      aspectRatio: '16:9',
      titleImagePath: images[0],
      titleText: 'Hello',
      outroImagePath: images[1],
      outroText: 'Thanks',
    });

    assert.equal(reply.error, undefined);
    assert.equal(reply.result.success, true);
    assert.ok(fs.statSync(outputPath).size > 0, 'the video was written');
    assert.ok(fs.statSync(outputPath.replace(/\.mp4$/, '.srt')).size > 0, 'the caption file was written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
