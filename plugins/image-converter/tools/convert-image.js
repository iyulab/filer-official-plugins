const { decodeToImageData, encodeFromImageData } = require('./codecs.js')

const SUPPORTED_SOURCE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const SUPPORTED_TARGET_FORMATS = new Set(['png', 'jpg', 'webp', 'gif', 'bmp'])
// svg matches EXT_TO_GROUP's "image" fileTypes group but has no raster decoder here by design —
// reject with a specific message, not a generic "unsupported format".
const VECTOR_SOURCE_EXTENSIONS = new Set(['svg'])

module.exports = async function handler(params, ctx) {
  const { path: sourcePath, targetFormat, outputPath } = params
  if (!sourcePath || !targetFormat || !outputPath) {
    return { success: false, error: 'path, targetFormat, and outputPath are required' }
  }

  const sourceExt = (sourcePath.split('.').pop() || '').toLowerCase()
  if (VECTOR_SOURCE_EXTENSIONS.has(sourceExt)) {
    return { success: false, error: 'SVG is a vector format and is not supported for conversion' }
  }
  if (!SUPPORTED_SOURCE_EXTENSIONS.has(sourceExt)) {
    return {
      success: false,
      error: `Unsupported source format: .${sourceExt}. Supported: png, jpg, jpeg, webp, gif, bmp`,
    }
  }
  if (!SUPPORTED_TARGET_FORMATS.has(targetFormat)) {
    return {
      success: false,
      error: `Unsupported target format: ${targetFormat}. Supported: png, jpg, webp, gif, bmp`,
    }
  }
  const normalizedSourceExt = sourceExt === 'jpeg' ? 'jpg' : sourceExt
  if (normalizedSourceExt === targetFormat) {
    return { success: false, error: `Source is already in ${targetFormat} format` }
  }

  // Refuse to overwrite — defense in depth, same as convert-data.js.
  try {
    await ctx.fs.read(outputPath)
    return { success: false, error: `${outputPath} already exists` }
  } catch {
    // ENOENT expected — target is free, proceed.
  }

  let buffer
  try {
    buffer = await ctx.fs.read(sourcePath)
  } catch (e) {
    return { success: false, error: `Failed to read source file: ${e.message}` }
  }

  let imageData
  try {
    imageData = await decodeToImageData(buffer, sourceExt)
  } catch (e) {
    return { success: false, error: `Failed to decode source image: ${e.message}` }
  }

  let outputBuffer
  try {
    outputBuffer = await encodeFromImageData(imageData, targetFormat)
  } catch (e) {
    return { success: false, error: `Failed to encode output image: ${e.message}` }
  }

  try {
    await ctx.fs.write(outputPath, outputBuffer)
  } catch (e) {
    return { success: false, error: `Failed to write output file: ${e.message}` }
  }

  return {
    success: true,
    path: outputPath,
    format: targetFormat,
    width: imageData.width,
    height: imageData.height,
  }
}
