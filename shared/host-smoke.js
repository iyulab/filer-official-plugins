'use strict';

// Drives a published plugin-host executable the way Filer does: one JSON request line on stdin, optional
// nested requests (`ai.complete`) on stdout that the caller answers on stdin, one final `result`/`error` line.
//
// Why this exists: the hosts are NativeAOT executables. A reflection-based serialization call builds without
// error under PublishAot and only throws once the published exe runs, and the unit tests run on the JIT with
// reflection on — so only a request sent to the published executable can see that class of failure.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const HOST_TIMEOUT_MS = 120_000;

/** The reason a smoke cannot run here, or null. The hosts are win-x64 executables. */
function skipReason(exe) {
  if (process.platform !== 'win32') return 'the plugin hosts are win-x64 executables';
  if (!fs.existsSync(exe)) return `no published host at ${exe} (publish it first — see the plugin's README)`;
  return null;
}

/** The answer line for a nested request: the caller's result, or an error the host sees as a failed request. */
function nestedReply(message, answerNested) {
  try {
    if (!answerNested) throw new Error(`unexpected nested request '${message.method}'`);
    return { id: message.id, result: answerNested(message.method, message.params) };
  } catch (err) {
    return { id: message.id, error: String(err.message) };
  }
}

/**
 * Sends one request and resolves with the host's final line ({ id, result } or { id, error }).
 * `answerNested(method, params)` returns the string result for a nested request.
 */
function runHost(exe, method, params, answerNested) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const id = 'smoke-1';
    let buffer = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${path.basename(exe)} gave no final line within ${HOST_TIMEOUT_MS} ms`));
    }, HOST_TIMEOUT_MS);

    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (typeof message.method === 'string') {
          child.stdin.write(`${JSON.stringify(nestedReply(message, answerNested))}\n`);
        } else {
          clearTimeout(timer);
          child.stdin.end();
          resolve(message);
        }
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (buffer.trim() === '') reject(new Error(`${path.basename(exe)} exited with ${code} before a final line. stderr: ${stderr}`));
    });

    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A solid-colour RGB PNG — enough image for ffmpeg, no dependency. */
function solidPng(width, height, [r, g, b]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { skipReason, runHost, solidPng };
