'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { skipReason, runHost } = require('../../shared/host-smoke.js');

const exe = path.join(__dirname, 'bin', 'TranscriptRefiner.PluginHost.exe');

const VTT = [
  'WEBVTT',
  '',
  '00:00:00.000 --> 00:00:04.000',
  '지금부터 마케팅 팀 주간 회를 시작하겠습니다',
  '',
  '00:00:04.000 --> 00:00:08.000',
  '참석자는 김인수 팀장과 박준호 사원입니다',
  '',
].join('\n');

// The published (NativeAOT) host, driven over its stdio protocol. See shared/host-smoke.js for why.
test('the published host refines a transcript through the caller\'s model and writes both files', { skip: skipReason(exe) ?? false }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-refiner-smoke-'));
  try {
    const source = path.join(dir, 'meeting.vtt');
    fs.writeFileSync(source, VTT, 'utf8');
    const outputPath = path.join(dir, 'meeting.clean.vtt');
    const changesPath = path.join(dir, 'meeting.changes.json');
    let calls = 0;

    const reply = await runHost(exe, 'refine_transcript', { path: source, outputPath, changesPath }, (method) => {
      assert.equal(method, 'ai.complete');
      calls++;
      return '[0] 지금부터 마케팅 팀 주간 회의를 시작하겠습니다\n[1] 참석자는 김인수 팀장과 박준호 사원입니다';
    });

    assert.equal(reply.error, undefined);
    assert.equal(reply.result.success, true);
    assert.ok(calls >= 1, 'the model was asked at least once');
    assert.match(fs.readFileSync(outputPath, 'utf8'), /주간 회의를/, 'the corrected cue was written');
    assert.equal(JSON.parse(fs.readFileSync(changesPath, 'utf8')).source, 'meeting.vtt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
