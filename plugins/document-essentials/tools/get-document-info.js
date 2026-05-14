module.exports = async function handler(params, ctx) {
  const filePath = params.path;
  if (!filePath) return { success: false, error: 'path is required' };

  const fileName = filePath.split(/[/\\]/).pop() || '';
  const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() || '' : '';

  try {
    const buffer = await ctx.fs.read(filePath);
    const size = buffer.length;
    const isBinary = buffer.includes(0x00);

    let wordCount = null;
    let lineCount = null;
    let charCount = null;

    if (!isBinary) {
      const text = buffer.toString('utf-8');
      lineCount = text.split('\n').length;
      charCount = text.length;
      wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    }

    return {
      success: true,
      path: filePath,
      fileName,
      extension: ext,
      size,
      sizeKb: parseFloat((size / 1024).toFixed(2)),
      isBinary,
      wordCount,
      lineCount,
      charCount,
    };
  } catch (e) {
    return { success: false, error: e.message, path: filePath };
  }
};
