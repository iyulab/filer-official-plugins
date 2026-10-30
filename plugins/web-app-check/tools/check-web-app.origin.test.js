const { test, before, after } = require('node:test')
// The "origin" save mode: the page saves by PUT to its own address, as it does on a Filer folder's web origin. The picker modes
// ("app", "other") and what a page may load: check-web-app.save.test.js and check-web-app.test.js.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const handler = require('./check-web-app.js')

const INDEX = `<!doctype html><meta charset="utf-8"><title>Notes</title>
<ul id="list"></ul><p id="status"></p>
<script src="notes.js"></script><script src="notes.edits.js"></script><script src="app.js"></script>`
const DATA = 'window.NOTES = [{ id: "a", text: "first" }, { id: "b", text: "second" }];'

// One corrections object, drawn from, saved at once by PUT of the whole edits file to the page's own relative address — the page the
// rewritten skill describes.
const GOOD_APP = `
const edits = Object.assign({}, window.NOTES_EDITS || {});
const status = document.getElementById('status');
async function save() {
  try {
    const r = await fetch('notes.edits.js', { method: 'PUT', headers: { 'X-Local-Origin': '1' }, body: 'window.NOTES_EDITS = ' + JSON.stringify(edits) + ';' });
    status.textContent = r.ok ? 'Saved.' : 'Could not save (' + r.status + ').';
  } catch (e) { status.textContent = 'Could not save: ' + e.message; }
}
function draw() {
  const list = document.getElementById('list'); list.textContent = '';
  for (const note of window.NOTES) {
    const li = document.createElement('li'); const box = document.createElement('input');
    box.type = 'checkbox'; box.id = 'done-' + note.id; box.checked = !!edits[note.id];
    box.addEventListener('change', () => { edits[note.id] = box.checked; draw(); save(); });
    li.append(box, note.text); list.append(li);
  }
}
draw();`

const NO_HEADER_APP = GOOD_APP.replace("headers: { 'X-Local-Origin': '1' }, ", '')
const OUTSIDE_APP = GOOD_APP.replace("fetch('notes.edits.js'", "fetch('../notes.edits.js'")
const NEVER_SAVES_APP = GOOD_APP.replace('draw(); save();', 'draw();')
const TOO_BIG_APP = GOOD_APP.replace("JSON.stringify(edits) + ';'", "JSON.stringify(edits) + ';' + 'x'.repeat(2 * 1024 * 1024 + 1)")

function edgeInstalled() {
  if (process.platform !== 'win32') return false
  return [process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.ProgramFiles ?? 'C:\\Program Files']
    .some((base) => fs.existsSync(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')))
}
const needsEdge = edgeInstalled() ? {} : { skip: 'Microsoft Edge is not installed here' }
let root

// An app where Filer keeps it: <folder>/.filer/artifacts/<app>, so the page's own FOLDER_ROOT line has a folder to find.
function makeApp(appJs) {
  const folder = fs.mkdtempSync(path.join(root, 'folder-'))
  const dir = path.join(folder, '.filer', 'artifacts', 'notes')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX)
  fs.writeFileSync(path.join(dir, 'notes.js'), DATA)
  fs.writeFileSync(path.join(dir, 'app.js'), appJs)
  fs.writeFileSync(path.join(folder, 'people.txt'), 'the person\'s own file')
  return dir
}

function hashTree(dir) {
  const hash = crypto.createHash('sha256')
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else hash.update(path.relative(dir, full)).update(fs.readFileSync(full))
    }
  }
  walk(dir)
  return hash.digest('hex')
}

const ctx = {
  fs: {
    read: (p) => fs.promises.readFile(p),
    list: (p) => fs.promises.readdir(p),
    exists: async (p) => fs.existsSync(p),
  },
  log: { warn() {} },
}

const SAVE_SCRIPT = [{ check: '#done-a' }, { wait: 300 }, { check: '#done-b' }, { wait: 300 }, { reload: true }, { expectValue: '#done-a', value: 'true' }, { expectValue: '#done-b', value: 'true' }]

before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-app-check-origin-test-')) })
after(() => fs.rmSync(root, { recursive: true, force: true }))

test('origin: a page that saves by PUT passes, the reload shows the save, and nothing is written to disk', needsEdge, async () => {
  const appDir = makeApp(GOOD_APP)
  const folder = path.dirname(path.dirname(path.dirname(appDir)))
  const before = hashTree(folder)

  const result = await handler({ appDir, saveFolder: 'origin', steps: SAVE_SCRIPT }, ctx)

  assert.equal(result.success, true, result.error)
  assert.equal(result.stepsFailed, 0, JSON.stringify(result.steps))
  assert.equal(result.saveFolder.puts.length, 2)
  assert.ok(result.saveFolder.puts.every((p) => p.file === 'notes.edits.js' && p.bytes > 0))
  assert.deepEqual(result.saveFolder.refusedPuts, [])
  assert.deepEqual(result.saveFolder.servedBackToThePage, [{ file: 'notes.edits.js', times: 1 }], 'the reload got the saved file')
  assert.match(result.saveFolder.summary, /saved 2 time\(s\), to: notes\.edits\.js/)
  assert.equal(hashTree(folder), before, 'the check must not write into the folder it verifies')
  assert.deepEqual(result.pageErrors, [])
})

test('origin: the page loads from an http origin, and its own FOLDER_ROOT line finds the folder', needsEdge, async () => {
  const appDir = makeApp(`${GOOD_APP}\ndocument.getElementById('status').textContent = location.href.slice(0, location.href.lastIndexOf('/.filer/') + 1);`)

  const result = await handler({ appDir, saveFolder: 'origin', steps: [{ expectText: 'http://127.0.0.1:5299/' }] }, ctx)

  assert.equal(result.success, true, result.error)
  assert.equal(result.stepsFailed, 0, JSON.stringify(result.steps))
  assert.deepEqual(result.missing, ['notes.edits.js'], 'the edits file is missing until the first save — reported, not refused')
  assert.deepEqual(result.blocked, [])
})

test('origin: a save without the page\'s header is refused the way the folder\'s origin refuses it, and said as a problem', needsEdge, async () => {
  const result = await handler({ appDir: makeApp(NO_HEADER_APP), saveFolder: 'origin', steps: SAVE_SCRIPT }, ctx)

  assert.equal(result.saveFolder.puts.length, 0)
  assert.equal(result.saveFolder.refusedPuts.length >= 1, true)
  assert.match(result.saveFolder.refusedPuts[0].reason, /X-Local-Origin: 1/)
  assert.match(result.saveFolder.summary, /^PROBLEM: /)
  assert.ok(result.stepsFailed >= 1, 'the values do not survive the reload')
})

test('origin: a save aimed outside the app\'s own folder is refused and written nowhere', needsEdge, async () => {
  const result = await handler({ appDir: makeApp(OUTSIDE_APP), saveFolder: 'origin', steps: SAVE_SCRIPT }, ctx)

  assert.equal(result.saveFolder.puts.length, 0)
  assert.match(result.saveFolder.refusedPuts[0].reason, /outside the app's own folder/)
  assert.match(result.saveFolder.summary, /^PROBLEM: /)
})

test('origin: a page that never saves is told so, as a sentence about what to send', needsEdge, async () => {
  const result = await handler({ appDir: makeApp(NEVER_SAVES_APP), saveFolder: 'origin', steps: SAVE_SCRIPT }, ctx)

  assert.equal(result.saveFolder.puts.length, 0)
  assert.match(result.saveFolder.summary, /sent no save/)
})

test('origin: one save over the limit is refused with the limit named', needsEdge, async () => {
  const result = await handler({ appDir: makeApp(TOO_BIG_APP), saveFolder: 'origin', steps: [{ check: '#done-a' }, { wait: 500 }] }, ctx)

  assert.equal(result.saveFolder.puts.length, 0)
  assert.match(result.saveFolder.refusedPuts[0].reason, /over the 2097152-byte limit/)
})

test('origin: the page cannot reach what is outside its folder or the network', needsEdge, async () => {
  const probe = `${GOOD_APP}
fetch('../../../people.txt').then((r) => { document.title = 'people ' + r.status }).catch(() => { document.title = 'people blocked' });
fetch('https://example.invalid/x').catch(() => {});`
  const result = await handler({ appDir: makeApp(probe), saveFolder: 'origin', steps: [{ wait: 500 }] }, ctx)

  assert.equal(result.success, true, result.error)
  assert.ok(result.blocked.some((b) => b.reason === 'outside appDir'), JSON.stringify(result.blocked))
  // The apps' CSP (connect-src 'self') refuses the network in the page itself, as it does on a folder's origin — before any request is made.
  assert.ok(result.consoleErrors.some((m) => /Content Security Policy/i.test(m)), JSON.stringify(result.consoleErrors))
})

test('origin: an unknown saveFolder value is refused with the three that exist', async () => {
  const result = await handler({ appDir: makeApp(GOOD_APP), saveFolder: 'cloud' }, ctx)

  assert.equal(result.success, false)
  assert.match(result.error, /"origin".*"app".*"other"/)
})
