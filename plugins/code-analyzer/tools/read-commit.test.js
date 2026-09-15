const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const handler = require('./read-commit.js');

function fsCtx() {
  return { fs: { list: async (dir) => fs.promises.readdir(dir) } };
}

function deniedCtx() {
  const err = new Error('code-analyzer: fs.list denied for that path (outside the agent folder)');
  err.name = 'PluginPermissionError';
  return { fs: { list: async () => { throw err; } } };
}

const identity = {
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-09-10T10:00:00+00:00',
  GIT_COMMITTER_DATE: '2026-09-10T10:00:00+00:00',
};

function commit(repo, message, files) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    if (content === null) {
      fs.rmSync(full);
      continue;
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: repo, env: { ...process.env, ...identity } });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

async function withRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-analyzer-git-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('read_commit returns the message, the per-file changes and the diff', async () => {
  await withRepo(async (repo) => {
    commit(repo, 'base', { 'a.js': 'line 1\nline 2\n', 'gone.js': 'bye\n' });
    const hash = commit(repo, 'change: edit a, add b, drop gone\n\nWhy: because.', {
      'a.js': 'line 1\nline two\n',
      'b.js': 'new\n',
      'gone.js': null,
    });

    const result = await handler({ folderPath: repo, hash }, fsCtx());

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.hash, hash);
    assert.equal(result.shortHash.length >= 7, true);
    assert.equal(result.subject, 'change: edit a, add b, drop gone');
    assert.equal(result.body, 'Why: because.');
    assert.equal(result.author, 'Test Author');
    assert.match(result.date, /^2026-09-10T10:00:00/);
    assert.equal(result.fileCount, 3);
    const byPath = Object.fromEntries(result.files.map((f) => [f.path, f]));
    assert.deepEqual(byPath['a.js'], { path: 'a.js', status: 'modified', insertions: 1, deletions: 1 });
    assert.deepEqual(byPath['b.js'], { path: 'b.js', status: 'added', insertions: 1, deletions: 0 });
    assert.deepEqual(byPath['gone.js'], { path: 'gone.js', status: 'deleted', insertions: 0, deletions: 1 });
    assert.match(result.diff, /^diff --git a\/a\.js b\/a\.js/m);
    assert.match(result.diff, /-line 2\n\+line two/);
    assert.equal(result.truncated, false);
    assert.equal(result.diffChars, result.diff.length);
  });
});

test('read_commit accepts the abbreviated hash list_commits returns', async () => {
  await withRepo(async (repo) => {
    const hash = commit(repo, 'only', { 'a.js': '1\n' });

    const result = await handler({ folderPath: repo, hash: hash.slice(0, 8) }, fsCtx());

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.hash, hash);
  });
});

test('read_commit limits files and diff to the folder subtree', async () => {
  await withRepo(async (repo) => {
    const hash = commit(repo, 'root and sub together', { 'README.md': 'root\n', 'sub/x.js': 'x\n' });

    const result = await handler({ folderPath: path.join(repo, 'sub'), hash }, fsCtx());

    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.files.map((f) => f.path), ['sub/x.js']);
    assert.match(result.diff, /sub\/x\.js/);
    assert.doesNotMatch(result.diff, /README\.md/);
  });
});

test('read_commit cuts the diff at maxDiffChars and says so', async () => {
  await withRepo(async (repo) => {
    const hash = commit(repo, 'big', { 'big.txt': Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n' });

    const result = await handler({ folderPath: repo, hash, maxDiffChars: 300 }, fsCtx());

    assert.equal(result.success, true);
    assert.equal(result.truncated, true);
    assert.equal(result.diff.length, 300);
    assert.equal(result.diffChars > 300, true);
  });
});

test('read_commit refuses a hash that is not hexadecimal and reports an unknown one as a failure', async () => {
  await withRepo(async (repo) => {
    commit(repo, 'only', { 'a.js': '1\n' });

    for (const hash of ['HEAD', 'main', '--output=x', 'HEAD~1', '']) {
      const result = await handler({ folderPath: repo, hash }, fsCtx());
      assert.equal(result.success, false, hash);
      assert.equal(result.reason, 'invalid-argument', hash);
    }

    const unknown = await handler({ folderPath: repo, hash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, fsCtx());
    assert.equal(unknown.success, false);
    assert.equal(unknown.reason, 'unknown-revision');
  });
});

test('read_commit never runs git for a folder the context refuses to list', async () => {
  await withRepo(async (repo) => {
    const hash = commit(repo, 'only', { 'a.js': '1\n' });

    const result = await handler({ folderPath: repo, hash }, deniedCtx());

    assert.equal(result.success, false);
    assert.equal(result.reason, 'permission');
    assert.equal(result.diff, undefined);
  });
});
