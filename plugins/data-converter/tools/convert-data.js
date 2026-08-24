const XLSX = require('xlsx')

const SUPPORTED_SOURCE_EXTENSIONS = new Set(['csv', 'json', 'xlsx', 'xls'])
const SUPPORTED_TARGET_FORMATS = new Set(['csv', 'json', 'xlsx'])

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length === 0) return { columns: [], rows: [] }

  const splitRow = (line) => {
    const result = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = !inQuotes
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim()); current = ''
      } else {
        current += ch
      }
    }
    result.push(current.trim())
    return result
  }

  const columns = splitRow(lines[0])
  const rows = lines.slice(1).map((line) => {
    const values = splitRow(line)
    const row = {}
    columns.forEach((col, i) => { row[col] = values[i] ?? '' })
    return row
  })
  return { columns, rows }
}

function toCsvField(value) {
  const str = value === null || value === undefined ? '' : String(value)
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

function toCsv(rows, columns) {
  const header = columns.map(toCsvField).join(',')
  const lines = rows.map((row) => columns.map((col) => toCsvField(row[col])).join(','))
  return [header, ...lines].join('\r\n')
}

function parseSource(buffer, ext) {
  if (ext === 'xlsx' || ext === 'xls') {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true })
    const sheet = workbook.Sheets[workbook.SheetNames[0]]
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' })
    const columns = rows.length > 0 ? Object.keys(rows[0]) : []
    return { rows, columns }
  }
  if (ext === 'json') {
    const parsed = JSON.parse(buffer.toString('utf-8'))
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    const columns = rows.length > 0 ? Object.keys(rows[0]) : []
    return { rows, columns }
  }
  return parseCsv(buffer.toString('utf-8'))
}

function serializeTarget(rows, columns, targetFormat) {
  if (targetFormat === 'csv') return Buffer.from(toCsv(rows, columns), 'utf-8')
  if (targetFormat === 'json') return Buffer.from(JSON.stringify(rows, null, 2), 'utf-8')
  const worksheet = XLSX.utils.json_to_sheet(rows)
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
}

module.exports = async function handler(params, ctx) {
  const { path: sourcePath, targetFormat, outputPath } = params
  if (!sourcePath || !targetFormat || !outputPath) {
    return { success: false, error: 'path, targetFormat, and outputPath are required' }
  }

  const sourceExt = (sourcePath.split('.').pop() || '').toLowerCase()
  if (!SUPPORTED_SOURCE_EXTENSIONS.has(sourceExt)) {
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

  let rows, columns
  try {
    ;({ rows, columns } = parseSource(buffer, sourceExt))
  } catch (e) {
    return { success: false, error: `Failed to parse source file: ${e.message}` }
  }

  const outputBuffer = serializeTarget(rows, columns, targetFormat)

  try {
    await ctx.fs.write(outputPath, outputBuffer)
  } catch (e) {
    return { success: false, error: `Failed to write output file: ${e.message}` }
  }

  return { success: true, path: outputPath, format: targetFormat, rowCount: rows.length }
}
