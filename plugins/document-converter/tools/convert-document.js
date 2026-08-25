const { toHtmlIntermediate, htmlToMd, htmlToText } = require('./converters.js')

const SUPPORTED_SOURCE_EXTENSIONS = new Set(['docx', 'md', 'html', 'txt'])
const SUPPORTED_TARGET_FORMATS = new Set(['pdf', 'html', 'md', 'txt'])

module.exports = async function handler(params, ctx) {
  const { path: sourcePath, targetFormat, outputPath } = params
  if (!sourcePath || !targetFormat || !outputPath) {
    return { success: false, error: 'path, targetFormat, and outputPath are required' }
  }

  const sourceExt = (sourcePath.split('.').pop() || '').toLowerCase()
  if (!SUPPORTED_SOURCE_EXTENSIONS.has(sourceExt)) {
    return {
      success: false,
      error: `Unsupported source format: .${sourceExt}. Supported: docx, md, html, txt`,
    }
  }
  if (!SUPPORTED_TARGET_FORMATS.has(targetFormat)) {
    return {
      success: false,
      error: `Unsupported target format: ${targetFormat}. Supported: pdf, html, md, txt`,
    }
  }
  if (sourceExt === targetFormat) {
    return { success: false, error: `Source is already in ${targetFormat} format` }
  }

  // Refuse to overwrite — defense in depth, same as convert-image.js / convert-data.js.
  try {
    await ctx.fs.read(outputPath)
    return { success: false, error: `${outputPath} already exists` }
  } catch {
    // ENOENT expected — target is free, proceed.
  }

  let sourceBuffer
  try {
    sourceBuffer = await ctx.fs.read(sourcePath)
  } catch (e) {
    return { success: false, error: `Failed to read source file: ${e.message}` }
  }

  let html
  try {
    html = await toHtmlIntermediate(sourceExt, sourceBuffer)
  } catch (e) {
    return { success: false, error: `Failed to parse source document: ${e.message}` }
  }

  let outputBuffer
  try {
    switch (targetFormat) {
      case 'html':
        outputBuffer = Buffer.from(html, 'utf-8')
        break
      case 'md':
        outputBuffer = Buffer.from(htmlToMd(html), 'utf-8')
        break
      case 'txt':
        outputBuffer = Buffer.from(htmlToText(html), 'utf-8')
        break
      case 'pdf':
        outputBuffer = await ctx.renderHtmlToPdf(html)
        break
    }
  } catch (e) {
    return { success: false, error: `Failed to produce ${targetFormat} output: ${e.message}` }
  }

  try {
    await ctx.fs.write(outputPath, outputBuffer)
  } catch (e) {
    return { success: false, error: `Failed to write output file: ${e.message}` }
  }

  return { success: true, path: outputPath, format: targetFormat }
}
