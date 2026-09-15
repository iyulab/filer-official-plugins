const {
  runGit,
  assertFolderScope,
  validateRef,
  validateSince,
  validateSubpath,
  validateLimit,
  reportFailure,
  LOG_FORMAT,
  parseLog,
} = require('./git-history.js');

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

module.exports = async function handler(params, ctx) {
  const folderPath = params.folderPath;
  if (!folderPath) return { success: false, error: 'folderPath is required' };

  try {
    await assertFolderScope(ctx, folderPath);
    const ref = validateRef(params.ref);
    const since = validateSince(params.since);
    const subpath = validateSubpath(params.path);
    const limit = validateLimit(params.limit, { fallback: DEFAULT_LIMIT, max: MAX_LIMIT });

    const args = ['log', `--max-count=${limit + 1}`, `--format=${LOG_FORMAT}`, '--shortstat', '--date=iso-strict'];
    if (since) args.push(`--since=${since}`);
    args.push(ref, '--', subpath ?? '.');

    // Sequential on purpose: a rejected `Promise.all` would return while the other git process is
    // still running in the folder (an orphan that outlives the call and can hold the folder open).
    const toplevel = await runGit(['rev-parse', '--show-toplevel'], folderPath);
    const stdout = await runGit(args, folderPath);
    const all = parseLog(stdout);
    const commits = all.slice(0, limit);

    return {
      success: true,
      folderPath,
      repoRoot: toplevel.trim(),
      ref,
      since: since ?? null,
      path: subpath ?? null,
      commits,
      count: commits.length,
      truncated: all.length > limit,
    };
  } catch (e) {
    return reportFailure(e, { folderPath });
  }
};
