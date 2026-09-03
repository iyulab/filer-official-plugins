const { decodeToImageData } = require('./codecs.js')

const MIN_FRAMES = 2
const MAX_FRAMES = 20
const SUPPORTED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp'])

// GIF frames are palette-indexed (max 256 colors, and omggif requires the palette length itself
// to be a power of two — a plain color count like 137 throws). Quantize by exact-match dedup,
// first-come-first-served past 256 distinct colors (adequate for combining a handful of small
// images; a perceptual quantizer is future scope), then round the palette up to the next power
// of two so omggif accepts it.
function quantizeFrame(imageData) {
  const { width, height, data } = imageData
  const colors = []
  const colorMap = new Map()
  const indexed = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2]
    const key = (r << 16) | (g << 8) | b
    let idx = colorMap.get(key)
    if (idx === undefined) {
      idx = colors.length < 256 ? colors.length : 0
      if (colors.length < 256) {
        colors.push([r, g, b])
        colorMap.set(key, idx)
      }
    }
    indexed[i] = idx
  }
  while (colors.length < 2) colors.push([0, 0, 0])
  let paletteSize = 2
  while (paletteSize < colors.length) paletteSize *= 2
  while (colors.length < paletteSize) colors.push([0, 0, 0])
  return { palette: colors.map(([r, g, b]) => (r << 16) | (g << 8) | b), indexed }
}

module.exports = async function handler(params, ctx) {
  const { paths, outputPath, frameDelayMs = 500, loop = true } = params
  if (!paths || !outputPath) {
    return { success: false, error: 'paths and outputPath are required' }
  }
  if (paths.length < MIN_FRAMES) {
    return { success: false, error: `At least ${MIN_FRAMES} images are required to make a GIF` }
  }
  if (paths.length > MAX_FRAMES) {
    return { success: false, error: `Too many images: ${paths.length}. Maximum is ${MAX_FRAMES}` }
  }

  try {
    await ctx.fs.read(outputPath)
    return { success: false, error: `${outputPath} already exists` }
  } catch {
    // ENOENT expected — target is free, proceed.
  }

  const frames = []
  for (const sourcePath of paths) {
    const ext = (sourcePath.split('.').pop() || '').toLowerCase()
    const normalizedExt = ext === 'jpeg' ? 'jpg' : ext
    if (!SUPPORTED_EXTENSIONS.has(ext) && !SUPPORTED_EXTENSIONS.has(normalizedExt)) {
      return { success: false, error: `Unsupported source format: ${sourcePath}. Supported: png, jpg, jpeg, webp, bmp` }
    }

    let buffer
    try {
      buffer = await ctx.fs.read(sourcePath)
    } catch (e) {
      return { success: false, error: `Failed to read ${sourcePath}: ${e.message}` }
    }

    let imageData
    try {
      imageData = await decodeToImageData(buffer, normalizedExt)
    } catch (e) {
      return { success: false, error: `Failed to decode ${sourcePath}: ${e.message}` }
    }

    if (frames.length > 0) {
      const first = frames[0]
      if (imageData.width !== first.width || imageData.height !== first.height) {
        return {
          success: false,
          error: `All images must be the same size to combine into a GIF: ${paths[0]} is `
            + `${first.width}x${first.height} but ${sourcePath} is ${imageData.width}x${imageData.height}`,
        }
      }
    }
    frames.push(imageData)
  }

  const { width, height } = frames[0]
  const omggif = require('omggif')
  const delayCentiseconds = Math.round(frameDelayMs / 10)
  const buf = Buffer.alloc(width * height * frames.length + 1024)
  const writer = new omggif.GifWriter(buf, width, height, loop ? { loop: 0 } : {})
  for (const frame of frames) {
    const { palette, indexed } = quantizeFrame(frame)
    writer.addFrame(0, 0, width, height, indexed, { palette, delay: delayCentiseconds })
  }
  const outputBuffer = buf.subarray(0, writer.end())

  await ctx.fs.write(outputPath, outputBuffer)

  return { success: true, path: outputPath, frameCount: frames.length, width, height }
}
