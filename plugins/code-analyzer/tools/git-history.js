// Shared plumbing for the two commit-history tools (list_commits, read_commit).
//
// History is read by running the machine's own `git` (no bundled git implementation): a code folder
// under version control has git on the machine by definition, and `git log`/`git show` are the
// reference behaviour a user would compare the tool against. Every invocation is `execFile` with a
// fixed argument list — never a shell, never a user-supplied string spliced into a command line —
// and every user-supplied value that reaches git is validated below to a shape git cannot read as
// an option or a revision expression.
//
// Scope: the tools answer for the *folder they are called on*, not for the whole repository. Every
// git command runs with the folder as its working directory and ends in `-- .`, so a folder that is
// a subdirectory of a larger repository only ever sees the commits and diffs that touch its own
// subtree — the same boundary the rest of Filer draws around a folder.
const { execFile } = require('node:child_process');

const MAX_BUFFER = 32 * 1024 * 1024;

class GitError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** The one call site that spawns git. Rejects with a GitError the tools turn into `{ success: false }`. */
function runGit(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if (err.code === 'ENOENT') {
          return reject(new GitError('not-installed', 'git is not available on this machine — install Git and make sure it is on PATH.'));
        }
        const detail = String(stderr || err.message || '').trim();
        if (/not a git repository/i.test(detail)) {
          return reject(new GitError('not-a-repo', 'This folder is not inside a Git repository.'));
        }
        if (/bad object|unknown revision|bad revision|ambiguous argument/i.test(detail)) {
          return reject(new GitError('unknown-revision', `git does not know that revision: ${detail.split('\n')[0]}`));
        }
        return reject(new GitError('failed', `git failed: ${detail.split('\n')[0] || err.message}`));
      },
    );
  });
}

/**
 * The folder-scope check. The runtime enforces "a parameter-supplied path stays inside the calling
 * agent's folder" inside `ctx.fs.*` — a handler that only spawns a process would bypass it. Listing
 * the folder through the context is what asserts the grant (`fs.list.parameter` in the manifest) and
 * the agent-folder boundary; its result is not used. A folder the caller may not list is a folder
 * whose history it may not read.
 */
async function assertFolderScope(ctx, folderPath) {
  await ctx.fs.list(folderPath);
}

const HASH = /^[0-9a-fA-F]{4,40}$/;
// A branch/tag name: no leading dash (git would read an option), no `..` (a range), no `@{` (a
// reflog selector), no whitespace or control characters.
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function validateHash(value) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new GitError('invalid-argument', 'hash must be a hexadecimal commit id (4–40 characters), as returned by list_commits.');
  }
  return value.toLowerCase();
}

function validateRef(value) {
  if (value === undefined || value === null || value === '') return 'HEAD';
  if (typeof value !== 'string' || !REF.test(value) || value.includes('..') || value.includes('@{')) {
    throw new GitError('invalid-argument', 'ref must be a branch or tag name (letters, digits, "." "_" "/" "-"; no leading "-", no "..").');
  }
  return value;
}

function validateSince(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !ISO_DATE.test(value)) {
    throw new GitError('invalid-argument', 'since must be an ISO date such as 2026-09-01 or 2026-09-01T09:00:00Z.');
  }
  return value;
}

/** A path inside the folder, relative, forward slashes, no `..` — it follows `--` on the command line. */
function validateSubpath(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new GitError('invalid-argument', 'path must be a string.');
  const posix = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (posix.startsWith('/') || /^[A-Za-z]:/.test(posix) || posix.startsWith('-')) {
    throw new GitError('invalid-argument', 'path must be relative to the folder (no absolute paths, no leading "-").');
  }
  if (posix.split('/').some((segment) => segment === '..')) {
    throw new GitError('invalid-argument', 'path must stay inside the folder (no "..").');
  }
  return posix;
}

function validateLimit(value, { fallback, max }) {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new GitError('invalid-argument', `limit must be a whole number between 1 and ${max}.`);
  return Math.min(n, max);
}

/** The tool's error result — `{ success: false, error, reason }` — for a GitError or a permission
 * refusal; anything else is a genuine failure and propagates. */
function reportFailure(err, extra) {
  if (err instanceof GitError) return { success: false, error: err.message, reason: err.kind, ...extra };
  if (err && err.name === 'PluginPermissionError') return { success: false, error: err.message, reason: 'permission', ...extra };
  throw err;
}

// One record per commit: `RS hash US short US author US date US subject US body`. The body may hold
// anything, which is why the separators are control characters no commit message carries.
const RS = '\x1e';
const US = '\x1f';
const LOG_FORMAT = `${RS}%H${US}%h${US}%an${US}%aI${US}%s${US}%b`;
const SHORTSTAT = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/;

/** Parses `git log --format=<LOG_FORMAT> --shortstat` output into commit summaries. */
function parseLog(stdout) {
  return stdout
    .split(RS)
    .filter((record) => record.trim().length > 0)
    .map((record) => {
      const [hash, shortHash, author, date, subject, rest = ''] = record.split(US);
      // The body runs to the shortstat line (if any) that `--shortstat` appends after it.
      const stat = SHORTSTAT.exec(rest);
      const body = (stat ? rest.slice(0, stat.index) : rest).trim();
      return {
        hash,
        shortHash,
        author,
        date,
        subject,
        body,
        filesChanged: stat ? Number(stat[1]) : 0,
        insertions: stat && stat[2] ? Number(stat[2]) : 0,
        deletions: stat && stat[3] ? Number(stat[3]) : 0,
      };
    });
}

module.exports = {
  GitError,
  runGit,
  assertFolderScope,
  validateHash,
  validateRef,
  validateSince,
  validateSubpath,
  validateLimit,
  reportFailure,
  LOG_FORMAT,
  parseLog,
};
