const { readFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const req = createRequire(__filename)

// Decode-only — gif-maker takes still images as input (png/jpg/webp/bmp) and produces one
// animated GIF as output. No GIF decode needed (animated GIF source is out of scope, matches
// image-converter's own decision to keep GIF as an output-only concern for this plugin).

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
      const decMod = await WebAssembly.compile(readFileSync(req.resolve('@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm')))
      await initDec(decMod)
    })()
  }
  await jpegReady
  return import('@jsquash/jpeg')
}

async function ensureWebp() {
  if (!webpReady) {
    webpReady = (async () => {
      const { init: initDec } = await import('@jsquash/webp/decode.js')
      const decMod = await WebAssembly.compile(readFileSync(req.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')))
      await initDec(decMod)
    })()
  }
  await webpReady
  return import('@jsquash/webp')
}

function decodeBmp(buffer) {
  const bmp = require('bmp-js')
  const decoded = bmp.decode(buffer)
  return { width: decoded.width, height: decoded.height, data: new Uint8ClampedArray(decoded.data) }
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
    case 'bmp':
      return decodeBmp(buffer)
    default:
      throw new Error(`No decoder for .${sourceExt}`)
  }
}

module.exports = { decodeToImageData }
