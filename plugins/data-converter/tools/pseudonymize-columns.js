// Replace the values of chosen columns with pseudonyms that are consistent within each column (the same value always gets
// the same pseudonym) and reversible through a key file written beside the copy. The source file is never changed.
const { SOURCE_EXTENSIONS, extensionOf, parseSource, serialize, toCsv, targetExists } = require('./tabular')

/** `name.ext` → `name.<suffix>.<ext>` in the same folder (an .xls source gets an .xlsx copy). */
function besideSource(sourcePath, suffix, ext) {
  const dot = sourcePath.lastIndexOf('.')
  const stem = dot > Math.max(sourcePath.lastIndexOf('/'), sourcePath.lastIndexOf('\\')) ? sourcePath.slice(0, dot) : sourcePath
  return `${stem}.${suffix}.${ext}`
}

/** A column's pseudonym prefix: its name with whitespace folded to underscores, so "First name" reads "First_name-0001". */
function prefixFor(column) {
  return String(column).trim().replace(/\s+/g, '_') || 'Value'
}

function isEmpty(value) {
  return value === null || value === undefined || String(value).trim() === ''
}

/**
 * Pseudonymize `columns` of `rows` in place of a copy. Returns the new rows and the key entries
 * ({ column, pseudonym, original }) in the order the pseudonyms were first given out. Empty cells stay empty.
 */
function pseudonymize(rows, columns) {
  const maps = new Map(columns.map((c) => [c, new Map()]))
  const key = []
  const out = rows.map((row) => {
    const copy = { ...row }
    for (const column of columns) {
      const original = row[column]
      if (isEmpty(original)) continue
      const map = maps.get(column)
      const text = original instanceof Date ? original.toISOString() : String(original)
      let pseudonym = map.get(text)
      if (pseudonym === undefined) {
        pseudonym = `${prefixFor(column)}-${String(map.size + 1).padStart(4, '0')}`
        map.set(text, pseudonym)
        key.push({ column, pseudonym, original: text })
      }
      copy[column] = pseudonym
    }
    return copy
  })
  return { rows: out, key }
}

module.exports = async function handler(params, ctx) {
  const { path: sourcePath, columns } = params
  if (!sourcePath || !Array.isArray(columns) || columns.length === 0) {
    return { success: false, error: 'path and at least one column name are required' }
  }
  const sourceExt = extensionOf(sourcePath)
  if (!SOURCE_EXTENSIONS.has(sourceExt)) {
    return { success: false, error: `Unsupported file format: .${sourceExt}. Supported: csv, json, xlsx, xls` }
  }
  const outputExt = sourceExt === 'xls' ? 'xlsx' : sourceExt
  const outputPath = params.outputPath || besideSource(sourcePath, 'pseudonymized', outputExt)
  const keyPath = besideSource(outputPath, 'key', 'csv')

  for (const target of [outputPath, keyPath]) {
    if (await targetExists(ctx, target)) return { success: false, error: `${target} already exists` }
  }

  let buffer
  try {
    buffer = await ctx.fs.read(sourcePath)
  } catch (e) {
    return { success: false, error: `Failed to read source file: ${e.message}` }
  }
  let table
  try {
    table = parseSource(buffer, sourceExt)
  } catch (e) {
    return { success: false, error: `Failed to parse source file: ${e.message}` }
  }

  const missing = columns.filter((c) => !table.columns.includes(c))
  if (missing.length > 0) {
    return {
      success: false,
      error: `No column named ${missing.map((c) => `"${c}"`).join(', ')}. The file's columns are: ${table.columns.map((c) => `"${c}"`).join(', ')}`,
    }
  }

  const { rows, key } = pseudonymize(table.rows, columns)
  try {
    await ctx.fs.write(outputPath, serialize(rows, table.columns, outputExt))
    await ctx.fs.write(keyPath, Buffer.from(toCsv(key, ['column', 'pseudonym', 'original']), 'utf-8'))
  } catch (e) {
    return { success: false, error: `Failed to write the pseudonymized copy: ${e.message}` }
  }

  return {
    success: true,
    path: outputPath,
    keyPath,
    rowCount: rows.length,
    columns,
    pseudonymCount: key.length,
    note: 'The copy is safe to share without the key file; keep the key file private — it maps each pseudonym back to its value.',
  }
}

module.exports.pseudonymize = pseudonymize
