function parseCsv(text, delimiter) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length === 0) return { columns: [], rows: [], rowCount: 0 };

  const splitRow = line => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === delimiter && !inQuotes) {
        result.push(current.trim()); current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  const columns = splitRow(lines[0]);
  const rows = lines.slice(1).map(line => {
    const values = splitRow(line);
    const row = {};
    columns.forEach((col, i) => { row[col] = values[i] ?? ''; });
    return row;
  });

  return { columns, rows, rowCount: rows.length };
}

module.exports = async function handler(params, ctx) {
  const filePath = params.path;
  if (!filePath) return { success: false, error: 'path is required' };

  const maxRows = params.maxRows ?? 200;
  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  try {
    const buffer = await ctx.fs.read(filePath);
    const size = buffer.length;
    const text = buffer.toString('utf-8');

    if (ext === 'json') {
      const data = JSON.parse(text);
      const isArray = Array.isArray(data);
      return {
        success: true,
        format: 'json',
        path: filePath,
        size,
        isArray,
        length: isArray ? data.length : null,
        data: isArray && data.length > maxRows ? data.slice(0, maxRows) : data,
        truncated: isArray && data.length > maxRows,
      };
    }

    if (ext === 'jsonl') {
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      const parsed = lines.slice(0, maxRows).map(l => JSON.parse(l));
      return {
        success: true,
        format: 'jsonl',
        path: filePath,
        size,
        rowCount: lines.length,
        data: parsed,
        truncated: lines.length > maxRows,
      };
    }

    if (ext === 'csv' || ext === 'tsv') {
      const delimiter = ext === 'tsv' ? '\t' : ',';
      const { columns, rows, rowCount } = parseCsv(text, delimiter);
      const preview = rows.slice(0, maxRows);
      return {
        success: true,
        format: ext,
        path: filePath,
        size,
        columns,
        rowCount,
        data: preview,
        truncated: rowCount > maxRows,
      };
    }

    return {
      success: true,
      format: 'text',
      path: filePath,
      size,
      data: text,
    };
  } catch (e) {
    return { success: false, error: e.message, path: filePath };
  }
};
