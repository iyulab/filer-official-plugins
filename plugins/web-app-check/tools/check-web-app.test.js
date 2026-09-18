const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const handler = require('./check-web-app.js')

// Headless Edge is the runtime this tool drives. Linux CI has no Edge: the checks that need a browser
// skip there rather than pass vacuously.
function edgeAvailable() {
  if (process.platform !== 'win32') return false
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  return candidates.some((p) => fs.existsSync(p))
}
const needsEdge = edgeAvailable() ? {} : { skip: 'Microsoft Edge is not installed here' }

// A ctx whose fs.read enforces a folder the way the runtime's grant does — the handler must ask it for
// every file the page loads, and honour its refusals.
function ctxFor(allowedRoot, reads) {
  return {
    fs: {
      read: async (p) => {
        reads?.push(p)
        const rel = path.relative(allowedRoot, path.resolve(p))
        if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`outside-folder-boundary: ${p}`)
        if (path.basename(p) === 'secret.env') throw new Error(`deny: ${p}`)
        return fs.promises.readFile(p)
      },
    },
    log: { warn() {} },
  }
}

function withApp(files, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-app-check-test-'))
  const app = path.join(root, 'app')
  fs.mkdirSync(app)
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(name.startsWith('../') ? root : app, name.replace('../', '')), body)
  return Promise.resolve(fn(app, root)).finally(() => fs.rmSync(root, { recursive: true, force: true }))
}

test('refuses a page outside appDir before starting a browser', async () => {
  await withApp({ 'index.html': '<p>x</p>' }, async (app) => {
    const r = await handler({ appDir: app, page: '../index.html' }, ctxFor(app))
    assert.equal(r.success, false)
    assert.match(r.error, /inside appDir/)
  })
})

test('a page the runtime refuses to read is not opened', async () => {
  await withApp({ 'index.html': '<p>x</p>' }, async (app, root) => {
    const r = await handler({ appDir: app }, ctxFor(path.join(root, 'elsewhere')))
    assert.equal(r.success, false)
    assert.match(r.error, /outside-folder-boundary/)
  })
})

test('reports the visible text and the error a generated app throws', needsEdge, async () => {
  await withApp({
    'index.html': '<!doctype html><title>Meetings</title><script src="data.js"></script><script src="app.js"></script><body><ul id="list"></ul></body>',
    'data.js': 'window.MEETINGS = [{ title: "Weekly" }]',
    // The meeting app's real defect shape: a stale capture renders an empty list, then a later call throws.
    'app.js': 'var ms = []; document.addEventListener("DOMContentLoaded", () => { document.getElementById("list").innerHTML = "<li>" + ms.length + " meetings</li>"; setTimeout(() => { ms.render() }, 50) })',
  }, async (app) => {
    const reads = []
    const r = await handler({ appDir: app }, ctxFor(app, reads))
    assert.equal(r.success, true, r.error)
    assert.equal(r.title, 'Meetings')
    assert.match(r.text, /0 meetings/)
    assert.equal(r.pageErrors.length, 1)
    assert.match(r.pageErrors[0], /render/)
    assert.ok(reads.some((p) => p.endsWith('data.js')) && reads.some((p) => p.endsWith('app.js')),
      'every file the page loaded was read through ctx.fs first')
  })
})

test('blocks files outside appDir, files the runtime denies, and every network request', needsEdge, async () => {
  await withApp({
    'index.html': '<!doctype html><script src="../outside.js"></script><script src="secret.env"></script><script src="https://example.com/x.js"></script><body><p id="o"></p><script>document.getElementById("o").textContent = String(window.OUT)</script></body>',
    'secret.env': 'window.OUT = "denied file ran"',
    '../outside.js': 'window.OUT = "outside file ran"',
  }, async (app) => {
    const r = await handler({ appDir: app }, ctxFor(app))
    assert.equal(r.success, true, r.error)
    assert.match(r.text, /undefined/)
    assert.deepEqual(r.missing, [], 'nothing missing here')
    const reasons = r.blocked.map((b) => b.reason).join(' | ')
    assert.match(reasons, /outside appDir/)
    assert.match(reasons, /deny/)
    assert.match(reasons, /network access is blocked/)
  })
})

test('clicks by selector, inside frames too, and says when nothing matched', needsEdge, async () => {
  await withApp({
    'index.html': '<!doctype html><body><button id="go" onclick="document.getElementById(\'o\').textContent=\'clicked\'">go</button><p id="o">idle</p></body>',
  }, async (app) => {
    const r = await handler({ appDir: app, clicks: ['#go', '#missing'] }, ctxFor(app))
    assert.equal(r.success, true, r.error)
    assert.match(r.text, /clicked/)
    assert.deepEqual(r.clicks.map((c) => c.clicked), [true, false])
  })
})

test('a file the page asks for that does not exist is reported as missing, not as refused', needsEdge, async () => {
  await withApp({ 'index.html': '<!doctype html><script src="optional-edits.js"></script><body>ok</body>' }, async (app) => {
    const r = await handler({ appDir: app }, ctxFor(app))
    assert.equal(r.success, true, r.error)
    assert.deepEqual(r.missing, ['optional-edits.js'])
    assert.deepEqual(r.blocked, [])
  })
})
