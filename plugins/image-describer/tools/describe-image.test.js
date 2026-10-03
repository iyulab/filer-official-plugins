const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const handler = require('./describe-image.js');

// 1×1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function ctxWith(complete) {
  const calls = [];
  return {
    calls,
    ctx: {
      fs: { read: async filePath => fs.promises.readFile(filePath) },
      ai: {
        complete: async (prompt, options) => {
          calls.push({ prompt, options });
          return complete(prompt, options);
        },
      },
    },
  };
}

async function withImage(name, bytes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-describer-test-'));
  try {
    const file = path.join(dir, name);
    fs.writeFileSync(file, bytes);
    await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('describe_image sends the image to the configured model and returns its text', async () => {
  await withImage('beach.png', PNG, async file => {
    const { ctx, calls } = ctxWith(async () => '  A sandy beach with grass in front.  ');

    const result = await handler({ path: file }, ctx);

    assert.equal(result.success, true);
    assert.equal(result.path, file);
    assert.equal(result.description, 'A sandy beach with grass in front.');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].options.imageUrls, [`data:image/png;base64,${PNG.toString('base64')}`]);
    assert.match(calls[0].prompt, /only what the image shows/i);
  });
});

test('describe_image asks the caller\'s question instead of the default one', async () => {
  await withImage('ticket.jpg', PNG, async file => {
    const { ctx, calls } = ctxWith(async () => 'The ticket is for a concert on 12 May 1994.');

    const result = await handler({ path: file, question: 'What event is this ticket for?' }, ctx);

    assert.equal(result.success, true);
    assert.match(calls[0].prompt, /What event is this ticket for\?/);
    assert.match(calls[0].options.imageUrls[0], /^data:image\/jpeg;base64,/);
  });
});

test('describe_image says when the model cannot be reached, with the host\'s guidance', async () => {
  await withImage('a.png', PNG, async file => {
    const { ctx } = ctxWith(async () => {
      throw new Error('Image understanding is not installed. Install it in Settings > AI > Image Understanding.');
    });

    const result = await handler({ path: file }, ctx);

    assert.equal(result.success, false);
    assert.match(result.error, /Settings > AI > Image Understanding/);
  });
});

test('describe_image refuses a file that is not a photo or picture it can send', async () => {
  await withImage('logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), async file => {
    const { ctx, calls } = ctxWith(async () => 'unused');

    const result = await handler({ path: file }, ctx);

    assert.equal(result.success, false);
    assert.match(result.error, /png, jpg/i);
    assert.equal(calls.length, 0);
  });
});

test('describe_image refuses an image over the 20 MB limit before reading the model', async () => {
  await withImage('huge.png', Buffer.alloc(20 * 1024 * 1024 + 1), async file => {
    const { ctx, calls } = ctxWith(async () => 'unused');

    const result = await handler({ path: file }, ctx);

    assert.equal(result.success, false);
    assert.match(result.error, /20 MB/);
    assert.equal(calls.length, 0);
  });
});

test('describe_image reports an empty answer as a failure, not as a description', async () => {
  await withImage('a.png', PNG, async file => {
    const { ctx } = ctxWith(async () => '   ');

    const result = await handler({ path: file }, ctx);

    assert.equal(result.success, false);
    assert.match(result.error, /no description/i);
  });
});
