const { SOURCE_EXTENSIONS, extensionOf, parseSource, serialize, targetExists } = require('./tabular')

const SUPPORTED_TARGET_FORMATS = new Set(['csv', 'json', 'xlsx'])

module.exports = async function handler(params, ctx) {
  const { path: sourcePath, targetFormat, outputPath } = params
  if (!sourcePath || !targetFormat || !outputPath) {
    return { success: false, error: 'path, targetFormat, and outputPath are required' }
  }

  const sourceExt = extensionOf(sourcePath)
  if (!SOURCE_EXTENSIONS.has(sourceExt)) {
    return { success: false, error: `Unsupported source format: .${sourceExt}. Supported: csv, json, xlsx, xls` }
  }
  if (!SUPPORTED_TARGET_FORMATS.has(targetFormat)) {
    return { success: false, error: `Unsupported target format: ${targetFormat}. Supported: csv, json, xlsx` }
  }
  if (sourceExt === targetFormat) {
    return { success: false, error: `Source is already in ${targetFormat} format` }
  }

  // Refuse to overwrite — defense in depth. resolveConvertedOutputPath (host side)
  // already picks a non-colliding path; this catches races and direct MCP/chat
  // calls that supply their own outputPath.
  if (await targetExists(ctx, outputPath)) {
    return { success: false, error: `${outputPath} already exists` }
  }

  let buffer
  try {
    buffer = await ctx.fs.read(sourcePath)
  } catch (e) {
    return { success: false, error: `Failed to read source file: ${e.message}` }
  }

  let rows, columns
  try {
    ;({ rows, columns } = parseSource(buffer, sourceExt))
  } catch (e) {
    return { success: false, error: `Failed to parse source file: ${e.message}` }
  }

  let outputBuffer
  try {
    outputBuffer = serialize(rows, columns, targetFormat)
  } catch (e) {
    return { success: false, error: `Failed to serialize output: ${e.message}` }
  }

  try {
    await ctx.fs.write(outputPath, outputBuffer)
  } catch (e) {
    return { success: false, error: `Failed to write output file: ${e.message}` }
  }

  return { success: true, path: outputPath, format: targetFormat, rowCount: rows.length }
}
