module.exports = async function handler(params, ctx) {
  const paths = params.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return { success: false, error: 'paths must be a non-empty array' };
  }

  const maxSizeBytes = (params.maxSizeKb ?? 500) * 1024;

  const results = await Promise.all(
    paths.map(async filePath => {
      const fileName = filePath.split(/[/\\]/).pop() || '';
      const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() || '' : '';
      try {
        const buffer = await ctx.fs.read(filePath);
        const size = buffer.length;

        if (size > maxSizeBytes) {
          return {
            path: filePath,
            fileName,
            extension: ext,
            size,
            success: false,
            error: `File too large (${(size / 1024).toFixed(1)} KB). Increase maxSizeKb to read.`,
          };
        }

        if (buffer.includes(0x00)) {
          return {
            path: filePath,
            fileName,
            extension: ext,
            size,
            success: false,
            error: 'Binary file — text content not available.',
          };
        }

        return {
          path: filePath,
          fileName,
          extension: ext,
          size,
          success: true,
          content: buffer.toString('utf-8'),
        };
      } catch (e) {
        return {
          path: filePath,
          fileName,
          extension: ext,
          success: false,
          error: e.message,
        };
      }
    })
  );

  const successCount = results.filter(r => r.success).length;

  return {
    success: true,
    totalRequested: paths.length,
    successCount,
    failCount: paths.length - successCount,
    files: results,
  };
};
