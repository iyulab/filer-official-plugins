const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const handler = require('./convert-image.js')
const { encodeFromImageData, decodeToImageData } = require('./codecs.js')

function fsCtx() {
  return {
    fs: {
      read: async (filePath) => fs.promises.readFile(filePath),
      write: async (filePath, data) => fs.promises.writeFile(filePath, data),
    },
  }
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-converter-test-'))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// 4x4 synthetic RGBA image, guaranteed-valid by construction (not a hand-typed binary fixture —
// cycle-580's spike found a hand-typed base64 PNG was silently corrupt and wasted a debugging pass).
// width/height default to 4x4 (16 distinct colors, a power of two by construction); pass a smaller
// pair to get a non-power-of-two distinct color count (each pixel's color is unique by formula).
function makeTestImageData(width = 4, height = 4) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = (i * 37) % 256
    data[i * 4 + 1] = (i * 71) % 256
    data[i * 4 + 2] = (i * 113) % 256
    data[i * 4 + 3] = 255
  }
  return { width, height, data }
}

async function writeTestSource(dir, format, imageData = makeTestImageData()) {
  const sourcePath = path.join(dir, `sample.${format}`)
  const bytes = await encodeFromImageData(imageData, format)
  fs.writeFileSync(sourcePath, bytes)
  return sourcePath
}

test('convert_image converts png to webp', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = await writeTestSource(dir, 'png')
    const outputPath = path.join(dir, 'sample.webp')

    const result = await handler({ path: sourcePath, targetFormat: 'webp', outputPath }, fsCtx())

    assert.equal(result.success, true)
    assert.equal(result.path, outputPath)
    assert.equal(result.width, 4)
    assert.equal(result.height, 4)
    assert.ok(fs.existsSync(outputPath))
    assert.ok(fs.statSync(outputPath).size > 0)
  })
})

test('convert_image converts jpg to png', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = await writeTestSource(dir, 'jpg')
    const outputPath = path.join(dir, 'sample.png')

    const result = await handler({ path: sourcePath, targetFormat: 'png', outputPath }, fsCtx())

    assert.equal(result.success, true)
    const decoded = await decodeToImageData(fs.readFileSync(outputPath), 'png')
    assert.equal(decoded.width, 4)
    assert.equal(decoded.height, 4)
  })
})

test('convert_image converts png to gif and back', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = await writeTestSource(dir, 'png')
    const gifPath = path.join(dir, 'sample.gif')

    const toGif = await handler({ path: sourcePath, targetFormat: 'gif', outputPath: gifPath }, fsCtx())
    assert.equal(toGif.success, true)

    const backPath = path.join(dir, 'roundtrip.png')
    const toPng = await handler({ path: gifPath, targetFormat: 'png', outputPath: backPath }, fsCtx())
    assert.equal(toPng.success, true)
    assert.equal(toPng.width, 4)
    assert.equal(toPng.height, 4)
  })
})

test('convert_image converts png to gif with a non-power-of-two distinct color count', async () => {
  await withTempDir(async (dir) => {
    // 3x1 image = exactly 3 distinct colors (not a power of two) — the 4x4/16-color default fixture
    // above never exercises this path, which is why the roundtrip test never caught the crash.
    const sourcePath = await writeTestSource(dir, 'png', makeTestImageData(3, 1))
    const gifPath = path.join(dir, 'sample.gif')

    const result = await handler({ path: sourcePath, targetFormat: 'gif', outputPath: gifPath }, fsCtx())

    assert.equal(result.success, true)
    assert.ok(fs.existsSync(gifPath))
  })
})

test('convert_image converts png to bmp and back losslessly', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = await writeTestSource(dir, 'png')
    const bmpPath = path.join(dir, 'sample.bmp')

    const toBmp = await handler({ path: sourcePath, targetFormat: 'bmp', outputPath: bmpPath }, fsCtx())
    assert.equal(toBmp.success, true)

    const decoded = await decodeToImageData(fs.readFileSync(bmpPath), 'bmp')
    assert.equal(decoded.width, 4)
    assert.equal(decoded.height, 4)
  })
})

test('convert_image refuses to overwrite an existing output file', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = await writeTestSource(dir, 'png')
    const outputPath = path.join(dir, 'existing.jpg')
    fs.writeFileSync(outputPath, 'not a real jpg')

    const result = await handler({ path: sourcePath, targetFormat: 'jpg', outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /already exists/)
    assert.equal(fs.readFileSync(outputPath, 'utf-8'), 'not a real jpg')
  })
})

test('convert_image rejects svg as a source', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'sample.svg')
    fs.writeFileSync(sourcePath, '<svg></svg>')
    const outputPath = path.join(dir, 'sample.png')

    const result = await handler({ path: sourcePath, targetFormat: 'png', outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /vector/i)
  })
})

test('convert_image rejects converting to the same format', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = await writeTestSource(dir, 'png')
    const outputPath = path.join(dir, 'sample2.png')

    const result = await handler({ path: sourcePath, targetFormat: 'png', outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /already in png format/)
  })
})

test('convert_image reports a clear error for a corrupt source file, not a crash', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'corrupt.png')
    fs.writeFileSync(sourcePath, 'this is not actually a png file')
    const outputPath = path.join(dir, 'out.webp')

    const result = await handler({ path: sourcePath, targetFormat: 'webp', outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /Failed to decode source image/)
    assert.ok(!fs.existsSync(outputPath), 'no partial output file should be written on decode failure')
  })
})

test('convert_image requires path, targetFormat, and outputPath', async () => {
  const result = await handler({ path: 'x.png' }, fsCtx())
  assert.equal(result.success, false)
  assert.match(result.error, /required/)
})
