const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const req = createRequire(__filename)

let pngReady, jpegReady, webpReady

async function ensurePng() {
  if (!pngReady) {
    pngReady = (async () => {
      const { init } = await import('@jsquash/png/decode.js')
      await init(readFileSync(req.resolve('@jsquash/png/codec/pkg/squoosh_png_bg.wasm')))
    })()
  }
  await pngReady
  return import('@jsquash/png')
}

async function ensureJpeg() {
  if (!jpegReady) {
    jpegReady = (async () => {
      const { init: initDec } = await import('@jsquash/jpeg/decode.js')
      const { init: initEnc } = await import('@jsquash/jpeg/encode.js')
      const decMod = await WebAssembly.compile(readFileSync(req.resolve('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm')))
      const encMod = await WebAssembly.compile(readFileSync(req.resolve('@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm')))
      await initDec(decMod)
      await initEnc(encMod)
    })()
  }
  await jpegReady
  return import('@jsquash/jpeg')
}

async function ensureWebp() {
  if (!webpReady) {
    webpReady = (async () => {
      const { init: initDec } = await import('@jsquash/webp/decode.js')
      const { init: initEnc } = await import('@jsquash/webp/encode.js')
      const decMod = await WebAssembly.compile(readFileSync(req.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')))
      const encMod = await WebAssembly.compile(readFileSync(req.resolve('@jsquash/webp/codec/enc/webp_enc.wasm')))
      await initDec(decMod)
      await initEnc(encMod)
    })()
  }
  await webpReady
  return import('@jsquash/webp')
}

function decodeGif(buffer) {
  const omggif = require('omggif')
  const reader = new omggif.GifReader(buffer)
  const { width, height } = reader
  const data = new Uint8ClampedArray(width * height * 4)
  reader.decodeAndBlitFrameRGBA(0, data)
  return { width, height, data }
}

function encodeGif(imageData) {
  const omggif = require('omggif')
  const { width, height, data } = imageData
  // GIF is palette-indexed (max 256 colors, and omggif requires the palette length itself to be a
  // power of two — a plain color count like 3 or 137 throws). Quantize by exact-match dedup,
  // first-come-first-served past 256 distinct colors (adequate for v1, a perceptual quantizer is
  // future scope), then round the palette up to the next power of two so omggif accepts it (mirrors
  // the sibling `gif-maker` plugin's `quantizeFrame`).
  const palette = []
  const paletteMap = new Map()
  const indexed = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
    const key = (r << 16) | (g << 8) | b
    let idx = paletteMap.get(key)
    if (idx === undefined) {
      idx = palette.length < 256 ? palette.length : 0
      if (palette.length < 256) {
        palette.push([r, g, b])
        paletteMap.set(key, idx)
      }
    }
    indexed[i] = idx
  }
  while (palette.length < 2) palette.push([0, 0, 0])
  let paletteSize = 2
  while (paletteSize < palette.length) paletteSize *= 2
  while (palette.length < paletteSize) palette.push([0, 0, 0])
  const buf = Buffer.alloc(width * height * 4 + 1024)
  const writer = new omggif.GifWriter(buf, width, height, {
    palette: palette.map(([r, g, b]) => (r << 16) | (g << 8) | b),
  })
  writer.addFrame(0, 0, width, height, indexed, {})
  return buf.subarray(0, writer.end())
}

function decodeBmp(buffer) {
  const bmp = require('bmp-js')
  const decoded = bmp.decode(buffer)
  return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) }
}

function encodeBmp(imageData) {
  const bmp = require('bmp-js')
  const encoded = bmp.encode({
    data: Buffer.from(imageData.data),
    width: imageData.width,
    height: imageData.height,
  })
  return encoded.data
}

async function decodeToImageData(buffer, sourceExt) {
  switch (sourceExt) {
    case 'png': {
      const { decode } = await ensurePng()
      return decode(buffer)
    }
    case 'jpg':
    case 'jpeg': {
      const { decode } = await ensureJpeg()
      return decode(buffer)
    }
    case 'webp': {
      const { decode } = await ensureWebp()
      return decode(buffer)
    }
    case 'gif':
      return decodeGif(buffer)
    case 'bmp':
      return decodeBmp(buffer)
    default:
      throw new Error(`No decoder for .${sourceExt}`)
  }
}

async function encodeFromImageData(imageData, targetFormat) {
  switch (targetFormat) {
    case 'png': {
      const { encode } = await ensurePng()
      return Buffer.from(await encode(imageData))
    }
    case 'jpg': {
      const { encode } = await ensureJpeg()
      return Buffer.from(await encode(imageData, { quality: 85 }))
    }
    case 'webp': {
      const { encode } = await ensureWebp()
      return Buffer.from(await encode(imageData, { quality: 85 }))
    }
    case 'gif':
      return encodeGif(imageData)
    case 'bmp':
      return encodeBmp(imageData)
    default:
      throw new Error(`No encoder for .${targetFormat}`)
  }
}

module.exports = { decodeToImageData, encodeFromImageData }
