module.exports = async function handler(params, ctx) {
  const folderPath = params.path;
  if (!folderPath) return { success: false, error: 'path is required' };

  const filterExt = params.filter?.toLowerCase().replace(/^\./, '');

  try {
    const entries = await ctx.fs.list(folderPath);

    const filtered = filterExt
      ? entries.filter(e => e.split('.').pop()?.toLowerCase() === filterExt)
      : entries;

    return {
      success: true,
      path: folderPath,
      entries: filtered,
      count: filtered.length,
    };
  } catch (e) {
    return { success: false, error: e.message, path: folderPath };
  }
};
