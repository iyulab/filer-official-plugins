const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const handler = require('./create-gif.js')

const req = createRequire(__filename)

function fsCtx() {
  return {
    fs: {
      read: async (filePath) => fs.promises.readFile(filePath),
      write: async (filePath, data) => fs.promises.writeFile(filePath, data),
    },
  }
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-maker-test-'))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// Distinct per-frame pixel data (not identical images) so a broken "only keeps last frame" bug
// would be visible if we ever inspect decoded frame content, not just numFrames().
function makeTestImageData(width, height, seed) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 37 + seed * 53) % 256
    data[i * 4 + 1] = (i * 71 + seed * 17) % 256
    data[i * 4 + 2] = (i * 113 + seed * 29) % 256
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

let pngEncodeReady
async function encodePng(imageData) {
  if (!pngEncodeReady) {
    pngEncodeReady = (async () => {
      const { init } = await import('@jsquash/png/encode.js')
      await init(readFileSync(req.resolve('@jsquash/png/codec/pkg/squoosh_png_bg.wasm')))
    })()
  }
  await pngEncodeReady
  const { encode } = await import('@jsquash/png')
  return Buffer.from(await encode(imageData))
}

function encodeBmp(imageData) {
  const bmp = require('bmp-js')
  return bmp.encode({
    data: Buffer.from(imageData.data),
    width: imageData.width,
    height: imageData.height,
  }).data
}

async function writePngFrame(dir, name, width, height, seed) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, await encodePng(makeTestImageData(width, height, seed)))
  return p
}

function writeBmpFrame(dir, name, width, height, seed) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, encodeBmp(makeTestImageData(width, height, seed)))
  return p
}

function readGif(filePath) {
  const omggif = require('omggif')
  return new omggif.GifReader(fs.readFileSync(filePath))
}

test('create_gif combines 3 images into one animated GIF', async () => {
  await withTempDir(async (dir) => {
    const paths = [
      await writePngFrame(dir, 'a.png', 4, 4, 1),
      await writePngFrame(dir, 'b.png', 4, 4, 2),
      await writePngFrame(dir, 'c.png', 4, 4, 3),
    ]
    const outputPath = path.join(dir, 'out.gif')

    const result = await handler({ paths, outputPath }, fsCtx())

    assert.equal(result.success, true)
    assert.equal(result.path, outputPath)
    assert.equal(result.frameCount, 3)
    assert.ok(fs.existsSync(outputPath))

    const reader = readGif(outputPath)
    assert.equal(reader.numFrames(), 3)
    assert.equal(reader.width, 4)
    assert.equal(reader.height, 4)
  })
})

test('create_gif defaults frame delay to 500ms (50 centiseconds)', async () => {
  await withTempDir(async (dir) => {
    const paths = [
      await writePngFrame(dir, 'a.png', 2, 2, 1),
      await writePngFrame(dir, 'b.png', 2, 2, 2),
    ]
    const outputPath = path.join(dir, 'out.gif')

    const result = await handler({ paths, outputPath }, fsCtx())

    assert.equal(result.success, true)
    const reader = readGif(outputPath)
    assert.equal(reader.frameInfo(0).delay, 50)
    assert.equal(reader.frameInfo(1).delay, 50)
  })
})

test('create_gif honors a custom frameDelayMs', async () => {
  await withTempDir(async (dir) => {
    const paths = [
      await writePngFrame(dir, 'a.png', 2, 2, 1),
      await writePngFrame(dir, 'b.png', 2, 2, 2),
    ]
    const outputPath = path.join(dir, 'out.gif')

    const result = await handler({ paths, outputPath, frameDelayMs: 200 }, fsCtx())

    assert.equal(result.success, true)
    const reader = readGif(outputPath)
    assert.equal(reader.frameInfo(0).delay, 20)
  })
})

test('create_gif loops infinitely by default', async () => {
  await withTempDir(async (dir) => {
    const paths = [
      await writePngFrame(dir, 'a.png', 2, 2, 1),
      await writePngFrame(dir, 'b.png', 2, 2, 2),
    ]
    const outputPath = path.join(dir, 'out.gif')

    await handler({ paths, outputPath }, fsCtx())

    assert.equal(readGif(outputPath).loopCount(), 0)
  })
})

test('create_gif plays once when loop is false', async () => {
  await withTempDir(async (dir) => {
    const paths = [
      await writePngFrame(dir, 'a.png', 2, 2, 1),
      await writePngFrame(dir, 'b.png', 2, 2, 2),
    ]
    const outputPath = path.join(dir, 'out.gif')

    const result = await handler({ paths, outputPath, loop: false }, fsCtx())

    assert.equal(result.success, true)
    assert.equal(readGif(outputPath).loopCount(), null)
  })
})

test('create_gif accepts mixed source formats (png + bmp)', async () => {
  await withTempDir(async (dir) => {
    const paths = [
      await writePngFrame(dir, 'a.png', 3, 3, 1),
      writeBmpFrame(dir, 'b.bmp', 3, 3, 2),
    ]
    const outputPath = path.join(dir, 'out.gif')

    const result = await handler({ paths, outputPath }, fsCtx())

    assert.equal(result.success, true)
    assert.equal(readGif(outputPath).numFrames(), 2)
  })
})

test('create_gif requires at least 2 images', async () => {
  await withTempDir(async (dir) => {
    const paths = [await writePngFrame(dir, 'a.png', 2, 2, 1)]
    const outputPath = path.join(dir, 'out.gif')

    const result = await handler({ paths, outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /at least 2/i)
  })
})

test('create_gif rejects more than 20 images', async () => {
  await withTempDir(async (dir) => {
    const paths = []
    for (let i = 0; i < 21; i++) {
      paths.push(await writePngFrame(dir, `f${i}.png`, 2, 2, i))
    }
    const outputPath = path.join(dir, 'out.gif')

    const result = await handler({ paths, outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /20/)
  })
})

test('create_gif refuses to overwrite an existing output file', async () => {
  await withTempDir(async (dir) => {
    const paths = [
      await writePngFrame(dir, 'a.png', 2, 2, 1),
      await writePngFrame(dir, 'b.png', 2, 2, 2),
    ]
    const outputPath = path.join(dir, 'existing.gif')
    fs.writeFileSync(outputPath, 'not a real gif')

    const result = await handler({ paths, outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /already exists/)
    assert.equal(fs.readFileSync(outputPath, 'utf-8'), 'not a real gif')
  })
})

test('create_gif rejects images with mismatched dimensions, naming the offending file', async () => {
  await withTempDir(async (dir) => {
    const paths = [
      await writePngFrame(dir, 'a.png', 4, 4, 1),
      await writePngFrame(dir, 'b.png', 8, 8, 2),
    ]
    const outputPath = path.join(dir, 'out.gif')

    const result = await handler({ paths, outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /b\.png/)
    assert.match(result.error, /4x4|8x8/)
  })
})

test('create_gif reports a clear error for a corrupt source file, not a crash', async () => {
  await withTempDir(async (dir) => {
    const good = await writePngFrame(dir, 'a.png', 2, 2, 1)
    const corrupt = path.join(dir, 'corrupt.png')
    fs.writeFileSync(corrupt, 'this is not actually a png file')
    const outputPath = path.join(dir, 'out.gif')

    const result = await handler({ paths: [good, corrupt], outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /corrupt\.png/)
    assert.ok(!fs.existsSync(outputPath), 'no partial output file should be written on decode failure')
  })
})

test('create_gif maps an overflow color to its nearest palette entry, not a fixed index', async () => {
  await withTempDir(async (dir) => {
    // A 50x50 image (2500 px — comfortably clears the encoder's local-palette + LZW overhead
    // for 2 frames of exactly 256 colors each): the first 256 pixels (raster order) form a red/
    // green gradient with 256 distinct colors — (i, 255-i, 0) for i in 0..255 — filling the
    // palette budget exactly. The remaining pixels are all (128, 128, 128), a color not present
    // in that gradient, forcing every one of them through the overflow path. Nearest-color search
    // over the gradient should land near i=127/128 (R and G both close to 127), not snap to
    // color(0) = (0, 255, 0) — the old behavior that crushed every overflow pixel to a fixed index.
    const width = 50, height = 50
    const data = new Uint8ClampedArray(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      if (i < 256) {
        data[i * 4] = i
        data[i * 4 + 1] = 255 - i
        data[i * 4 + 2] = 0
      } else {
        data[i * 4] = 128
        data[i * 4 + 1] = 128
        data[i * 4 + 2] = 128
      }
      data[i * 4 + 3] = 255
    }
    const p = path.join(dir, 'gradient.png')
    fs.writeFileSync(p, await encodePng({ width, height, data }))

    const paths = [p, await writePngFrame(dir, 'b.png', width, height, 2)]
    const outputPath = path.join(dir, 'out.gif')

    const result = await handler({ paths, outputPath }, fsCtx())
    assert.equal(result.success, true)

    const reader = readGif(outputPath)
    const pixels = new Uint8Array(width * height * 4)
    reader.decodeAndBlitFrameRGBA(0, pixels)
    // Pixel 256 is the first overflow pixel (index 256 in raster order, i.e. row 12, col 16).
    const r = pixels[256 * 4]
    const g = pixels[256 * 4 + 1]
    assert.ok(r > 80 && r < 176, `expected R near the gradient midpoint (~127), got ${r}`)
    assert.ok(g > 80 && g < 176, `expected G near the gradient midpoint (~127), got ${g}`)
    assert.ok(!(r === 0 && g === 255), 'overflow pixel must not be crushed to the fixed color(0) index')
  })
})

test('create_gif requires paths and outputPath', async () => {
  const result = await handler({ paths: ['x.png'] }, fsCtx())
  assert.equal(result.success, false)
  assert.match(result.error, /required/)
})
