// Reading and writing the tabular formats this plugin handles (CSV, JSON array of objects, Excel), shared by its tools.
const XLSX = require('xlsx')

const SOURCE_EXTENSIONS = new Set(['csv', 'json', 'xlsx', 'xls'])

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

/** The lower-case extension of a path, without the dot. */
function extensionOf(filePath) {
  return (filePath.split('.').pop() || '').toLowerCase()
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

function serialize(rows, columns, format) {
  if (format === 'csv') return Buffer.from(toCsv(rows, columns), 'utf-8')
  if (format === 'json') return Buffer.from(JSON.stringify(rows, null, 2), 'utf-8')
  const worksheet = XLSX.utils.json_to_sheet(rows, { header: columns })
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1')
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' })
}

// Hosts from 2026-09-12 on expose ctx.fs.exists; older hosts do not (the packaged app fetches these
// plugins at the repository's HEAD, so a plugin must not assume a context method its host may lack).
// On an older host the only probe is a read: a failed read means the target is free.
async function targetExists(ctx, path) {
  if (typeof ctx.fs.exists === 'function') return ctx.fs.exists(path)
  try {
    await ctx.fs.read(path)
    return true
  /* eslint-disable-next-line local/no-silent-catch -- read-as-probe on a host without ctx.fs.exists:
     a failed read means "free"; any other read error resurfaces at write. */
  } catch {
    return false
  }
}

module.exports = { SOURCE_EXTENSIONS, extensionOf, parseSource, serialize, toCsv, targetExists }
