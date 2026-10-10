const {
  runGit,
  assertFolderScope,
  validateHash,
  validateLimit,
  reportFailure,
  LOG_FORMAT,
  parseLog,
} = require('./git-history.js');

const DEFAULT_MAX_DIFF_CHARS = 20_000;
const MAX_DIFF_CHARS = 200_000;

const STATUS_NAMES = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type-changed', U: 'unmerged' };

/** `git show --name-status` line → `{ path, status, previousPath? }`. */
function parseNameStatus(stdout) {
  const files = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [code, ...paths] = line.split('\t');
    const letter = code[0];
    const entry = { path: paths[paths.length - 1], status: STATUS_NAMES[letter] ?? code };
    if ((letter === 'R' || letter === 'C') && paths.length === 2) entry.previousPath = paths[0];
    files.push(entry);
  }
  return files;
}

/** `git show --numstat` line → `{ path: { insertions, deletions } }`; a binary file reports `-`. */
function parseNumstat(stdout) {
  const byPath = new Map();
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [ins, del, ...rest] = line.split('\t');
    const path = rest[rest.length - 1];
    byPath.set(path, {
      insertions: ins === '-' ? null : Number(ins),
      deletions: del === '-' ? null : Number(del),
    });
  }
  return byPath;
}

/** The repository-relative paths among `paths` that the host's denylist refuses; none when the host cannot be asked. */
async function deniedPaths(ctx, folderPath, paths) {
  if (paths.length === 0 || typeof ctx.fs?.isDenied !== 'function') return [];
  const top = (await runGit(['rev-parse', '--show-toplevel'], folderPath)).trim();
  const denied = [];
  for (const p of paths) {
    if (await ctx.fs.isDenied(`${top}/${p}`)) denied.push(p);
  }
  return denied;
}

module.exports = async function handler(params, ctx) {
  const folderPath = params.folderPath;
  if (!folderPath) return { success: false, error: 'folderPath is required' };

  try {
    await assertFolderScope(ctx, folderPath);
    const hash = validateHash(params.hash);
    const maxDiffChars = validateLimit(params.maxDiffChars, { fallback: DEFAULT_MAX_DIFF_CHARS, max: MAX_DIFF_CHARS });

    // The metadata call first, alone: it is the one that fails on an unknown hash, and a rejected
    // `Promise.all` would leave the other git processes running in the folder after the call
    // returned. Once the hash resolves, the three folder-scoped reads cannot fail on it.
    const meta = await runGit(['show', '--no-patch', `--format=${LOG_FORMAT}`, hash], folderPath);
    const [commit] = parseLog(meta);
    if (!commit) return { success: false, error: 'git returned no commit for that hash.', reason: 'unknown-revision', folderPath, hash };

    // Paths unquoted (`core.quotepath=false`): a non-ASCII name is reported as itself, and the exclusions below match it.
    const show = (...args) => runGit(['-c', 'core.quotepath=false', 'show', '--format=', ...args], folderPath);
    const changed = parseNameStatus(await show('--name-status', '--no-renames', hash, '--', '.'));

    // A file the host's path denylist refuses (a committed `.env`, a key) is left out of the commit as the model sees it —
    // its name, its line counts and its diff — exactly as `ctx.fs` would refuse to read it. Git, not `ctx.fs`, reads these
    // bytes, so the tool asks the question itself. A host too old to answer it (no `ctx.fs.isDenied`) withholds nothing.
    const withheld = await deniedPaths(ctx, folderPath, changed.map((f) => f.path));
    const excludes = withheld.map((p) => `:(top,exclude,literal)${p}`);
    const [numstat, patch] = await Promise.all([
      show('--numstat', '--no-renames', hash, '--', '.', ...excludes),
      show('--patch', '--no-color', hash, '--', '.', ...excludes),
    ]);

    const stats = parseNumstat(numstat);
    const files = changed.filter((f) => !withheld.includes(f.path)).map((f) => ({
      ...f,
      insertions: stats.get(f.path)?.insertions ?? null,
      deletions: stats.get(f.path)?.deletions ?? null,
    }));

    const truncated = patch.length > maxDiffChars;
    return {
      success: true,
      folderPath,
      hash: commit.hash,
      shortHash: commit.shortHash,
      author: commit.author,
      date: commit.date,
      subject: commit.subject,
      body: commit.body,
      files,
      fileCount: files.length,
      ...(withheld.length > 0 ? { withheldFiles: withheld.length, withheldReason: 'secret-like files are never read' } : {}),
      diff: truncated ? patch.slice(0, maxDiffChars) : patch,
      diffChars: patch.length,
      truncated,
    };
  } catch (e) {
    return reportFailure(e, { folderPath, hash: params.hash });
  }
};
