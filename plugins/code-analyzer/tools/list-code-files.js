const DEFAULT_CODE_EXTENSIONS = new Set([
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx',
  'py', 'cs', 'java', 'cpp', 'cc', 'cxx', 'c', 'h', 'hpp',
  'go', 'rs', 'rb', 'php', 'swift', 'kt', 'scala', 'r',
  'sh', 'bash', 'ps1', 'psm1', 'sql',
  'html', 'htm', 'css', 'scss', 'sass', 'less',
  'vue', 'dart', 'lua', 'ex', 'exs',
]);

module.exports = async function handler(params, ctx) {
  const folderPath = params.folderPath;
  if (!folderPath) return { success: false, error: 'folderPath is required' };

  const allowedExts = params.extensions
    ? new Set(params.extensions.map(e => e.toLowerCase().replace(/^\./, '')))
    : DEFAULT_CODE_EXTENSIONS;

  try {
    const entries = await ctx.fs.list(folderPath);
    const codeFiles = entries.filter(entry => {
      const ext = entry.split('.').pop()?.toLowerCase() || '';
      return allowedExts.has(ext);
    });

    return {
      success: true,
      folderPath,
      files: codeFiles,
      count: codeFiles.length,
    };
  } catch (e) {
    return { success: false, error: e.message, folderPath };
  }
};
