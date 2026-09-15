const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const handler = require('./list-commits.js');

// The context a tool sees: `fs.list` is what the runtime scope-checks a parameter-supplied folder
// against (see git-history.js assertFolderScope) — here it is the real readdir.
function fsCtx() {
  return { fs: { list: async (dir) => fs.promises.readdir(dir) } };
}

// A context whose scope check refuses — the shape the secure context throws for a folder outside
// the calling agent's folder.
function deniedCtx() {
  const err = new Error('code-analyzer: fs.list denied for that path (outside the agent folder)');
  err.name = 'PluginPermissionError';
  return { fs: { list: async () => { throw err; } } };
}

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_AUTHOR_DATE: '2026-09-10T10:00:00+00:00',
      GIT_COMMITTER_DATE: '2026-09-10T10:00:00+00:00',
    },
  });
}

function commit(repo, message, files, date) {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'test@example.invalid',
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
}

async function withRepo(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-analyzer-git-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('list_commits returns the folder history newest first with shortstat counts', async () => {
  await withRepo(async (repo) => {
    const first = commit(repo, 'first: add a', { 'a.js': 'a\n' }, '2026-09-10T10:00:00+00:00');
    const second = commit(repo, 'second: change a, add b\n\nBody line one.\nBody line two.', { 'a.js': 'a\nb\n', 'b.js': 'b\n' }, '2026-09-11T10:00:00+00:00');

    const result = await handler({ folderPath: repo }, fsCtx());

    assert.equal(result.success, true, JSON.stringify(result));
    assert.equal(result.ref, 'HEAD');
    assert.equal(result.count, 2);
    assert.equal(result.truncated, false);
    assert.equal(path.resolve(result.repoRoot), path.resolve(fs.realpathSync(repo)));
    assert.deepEqual(result.commits.map((c) => c.hash), [second, first]);
    const [top] = result.commits;
    assert.equal(top.subject, 'second: change a, add b');
    assert.equal(top.body, 'Body line one.\nBody line two.');
    assert.equal(top.author, 'Test Author');
    assert.match(top.date, /^2026-09-11T10:00:00/);
    assert.equal(top.filesChanged, 2);
    assert.equal(top.insertions, 2);
    assert.equal(top.deletions, 0);
    assert.equal(result.commits[1].body, '');
  });
});

test('list_commits answers for the folder subtree only, not the whole repository', async () => {
  await withRepo(async (repo) => {
    commit(repo, 'root only', { 'README.md': 'root\n' }, '2026-09-10T10:00:00+00:00');
    const inSub = commit(repo, 'touches sub', { 'sub/x.js': 'x\n' }, '2026-09-11T10:00:00+00:00');
    commit(repo, 'root again', { 'README.md': 'root 2\n' }, '2026-09-12T10:00:00+00:00');

    const result = await handler({ folderPath: path.join(repo, 'sub') }, fsCtx());

    assert.equal(result.success, true, JSON.stringify(result));
    assert.deepEqual(result.commits.map((c) => c.hash), [inSub]);
  });
});

test('list_commits honours limit (with a truncated flag), since and path', async () => {
  await withRepo(async (repo) => {
    commit(repo, 'one', { 'a.js': '1\n' }, '2026-09-01T10:00:00+00:00');
    const two = commit(repo, 'two', { 'b.js': '2\n' }, '2026-09-05T10:00:00+00:00');
    const three = commit(repo, 'three', { 'a.js': '3\n' }, '2026-09-09T10:00:00+00:00');

    const limited = await handler({ folderPath: repo, limit: 2 }, fsCtx());
    assert.equal(limited.count, 2);
    assert.equal(limited.truncated, true);
    assert.deepEqual(limited.commits.map((c) => c.subject), ['three', 'two']);

    const since = await handler({ folderPath: repo, since: '2026-09-04' }, fsCtx());
    assert.deepEqual(since.commits.map((c) => c.hash), [three, two]);
    assert.equal(since.since, '2026-09-04');

    const onlyA = await handler({ folderPath: repo, path: 'a.js' }, fsCtx());
    assert.deepEqual(onlyA.commits.map((c) => c.subject), ['three', 'one']);
    assert.equal(onlyA.path, 'a.js');
  });
});

test('list_commits reads a named branch when ref is given', async () => {
  await withRepo(async (repo) => {
    commit(repo, 'on main', { 'a.js': '1\n' }, '2026-09-01T10:00:00+00:00');
    git(repo, 'checkout', '-q', '-b', 'feature');
    const onFeature = commit(repo, 'on feature', { 'f.js': 'f\n' }, '2026-09-02T10:00:00+00:00');
    git(repo, 'checkout', '-q', 'main');

    const main = await handler({ folderPath: repo }, fsCtx());
    assert.deepEqual(main.commits.map((c) => c.subject), ['on main']);

    const feature = await handler({ folderPath: repo, ref: 'feature' }, fsCtx());
    assert.equal(feature.commits[0].hash, onFeature);
  });
});

test('list_commits refuses values git could read as options or ranges', async () => {
  await withRepo(async (repo) => {
    commit(repo, 'one', { 'a.js': '1\n' }, '2026-09-01T10:00:00+00:00');

    for (const ref of ['--output=/tmp/x', 'main..feature', 'HEAD@{1}', '-p']) {
      const result = await handler({ folderPath: repo, ref }, fsCtx());
      assert.equal(result.success, false, ref);
      assert.equal(result.reason, 'invalid-argument', ref);
    }
    for (const p of ['../other', '/etc/passwd', '-p', 'a/../../b']) {
      const result = await handler({ folderPath: repo, path: p }, fsCtx());
      assert.equal(result.success, false, p);
      assert.equal(result.reason, 'invalid-argument', p);
    }
    const badSince = await handler({ folderPath: repo, since: '--all' }, fsCtx());
    assert.equal(badSince.reason, 'invalid-argument');
    const badLimit = await handler({ folderPath: repo, limit: 0 }, fsCtx());
    assert.equal(badLimit.reason, 'invalid-argument');
  });
});

test('list_commits reports an unknown branch and a folder outside any repository as failures, not throws', async () => {
  await withRepo(async (repo) => {
    commit(repo, 'one', { 'a.js': '1\n' }, '2026-09-01T10:00:00+00:00');
    const unknown = await handler({ folderPath: repo, ref: 'no-such-branch' }, fsCtx());
    assert.equal(unknown.success, false);
    assert.equal(unknown.reason, 'unknown-revision');
  });

  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'code-analyzer-plain-'));
  try {
    // A temp dir may itself sit inside a repository on a developer machine; only assert when it does not.
    let inside = true;
    try { execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: plain, stdio: 'pipe' }); } catch { inside = false; }
    if (!inside) {
      const result = await handler({ folderPath: plain }, fsCtx());
      assert.equal(result.success, false);
      assert.equal(result.reason, 'not-a-repo');
    }
  } finally {
    fs.rmSync(plain, { recursive: true, force: true });
  }
});

test('list_commits never runs git for a folder the context refuses to list', async () => {
  await withRepo(async (repo) => {
    commit(repo, 'one', { 'a.js': '1\n' }, '2026-09-01T10:00:00+00:00');

    const result = await handler({ folderPath: repo }, deniedCtx());

    assert.equal(result.success, false);
    assert.equal(result.reason, 'permission');
    assert.equal(result.commits, undefined);
  });
});

test('list_commits requires folderPath', async () => {
  const result = await handler({}, fsCtx());
  assert.equal(result.success, false);
  assert.match(result.error, /folderPath/);
});
