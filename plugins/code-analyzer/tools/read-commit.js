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

    const [nameStatus, numstat, patch] = await Promise.all([
      runGit(['show', '--format=', '--name-status', '--no-renames', hash, '--', '.'], folderPath),
      runGit(['show', '--format=', '--numstat', '--no-renames', hash, '--', '.'], folderPath),
      runGit(['show', '--format=', '--patch', '--no-color', hash, '--', '.'], folderPath),
    ]);

    const stats = parseNumstat(numstat);
    const files = parseNameStatus(nameStatus).map((f) => ({
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
      diff: truncated ? patch.slice(0, maxDiffChars) : patch,
      diffChars: patch.length,
      truncated,
    };
  } catch (e) {
    return reportFailure(e, { folderPath, hash: params.hash });
  }
};
