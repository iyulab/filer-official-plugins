const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'rst', 'html', 'htm', 'xml', 'svg',
  'json', 'jsonl', 'csv', 'tsv', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'log', 'tex', 'rtf', 'org', 'adoc', 'asciidoc',
]);

module.exports = async function handler(params, ctx) {
  const filePath = params.path;
  if (!filePath) return { success: false, error: 'path is required' };

  const ext = filePath.split('.').pop()?.toLowerCase() || '';

  try {
    const buffer = await ctx.fs.read(filePath);
    const size = buffer.length;

    if (!TEXT_EXTENSIONS.has(ext) && size > 1_000_000) {
      return {
        success: false,
        error: `File too large (${(size / 1024).toFixed(1)} KB) and not a recognized text format. Use a text editor to view this file.`,
        path: filePath,
        extension: ext,
        size,
      };
    }

    const content = buffer.toString('utf-8');

    if (content.includes('\x00')) {
      return {
        success: false,
        error: 'File appears to be binary and cannot be read as text.',
        path: filePath,
        extension: ext,
        size,
      };
    }

    return {
      success: true,
      path: filePath,
      extension: ext,
      size,
      content,
    };
  } catch (e) {
    return { success: false, error: e.message, path: filePath };
  }
};
