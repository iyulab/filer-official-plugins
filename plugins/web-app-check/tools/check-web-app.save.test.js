const { test, before, after } = require('node:test')
// The steps script and the save exercise. What the page may load and what is blocked: check-web-app.test.js.
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const handler = require('./check-web-app.js')

// ---- steps: validated before a browser is started -------------------------------------------------

test('steps: a well-formed script parses', () => {
  const { steps, error } = handler.parseSteps([
    { click: '#a' }, { fill: '#b', value: 'x' }, { reload: true }, { wait: 100 }, { expectValue: '#b', value: 'x' },
  ])
  assert.equal(error, undefined)
  assert.deepEqual(steps.map((s) => s.action), ['click', 'fill', 'reload', 'wait', 'expectValue'])
})

test('steps: no script is an empty script', () => {
  assert.deepEqual(handler.parseSteps(undefined), { steps: [] })
})

for (const [name, steps, fragment] of [
  ['two actions in one step', [{ click: '#a', reload: true }], 'exactly one action'],
  ['no action', [{ value: 'x' }], 'exactly one action'],
  ['fill without a value', [{ fill: '#a' }], 'needs "value"'],
  ['reload with a selector', [{ reload: '#a' }], '{"reload": true}'],
  ['wait with a string', [{ wait: 'soon' }], 'milliseconds'],
  ['not a list', { click: '#a' }, 'must be a list'],
  ['too many', Array.from({ length: 41 }, () => ({ click: '#a' })), 'limit'],
]) {
  test(`steps: ${name} is refused with a sentence that names the entry`, () => {
    const { error } = handler.parseSteps(steps)
    assert.ok(error && error.includes(fragment), error)
  })
}

// ---- the save exercise: needs Microsoft Edge ------------------------------------------------------

const INDEX = `<!doctype html><meta charset="utf-8"><title>Notes</title>
<ul id="list"></ul><button id="connect">Connect save folder</button><p id="status"></p>
<script src="notes.js"></script><script src="notes.edits.js"></script><script src="app.js"></script>`
const DATA = 'window.NOTES = [{ id: "a", text: "first" }, { id: "b", text: "second" }];'

// Keeps one corrections object, draws from it, writes it on every change once connected, flushes it on connect,
// walks the folder with for-await and compares names — the page the instructions describe.
const GOOD_APP = `
const edits = Object.assign({}, window.NOTES_EDITS || {});
let folder = null;
function draw() {
  const list = document.getElementById('list'); list.textContent = '';
  for (const note of window.NOTES) {
    const li = document.createElement('li'); const box = document.createElement('input');
    box.type = 'checkbox'; box.id = 'done-' + note.id; box.checked = !!edits[note.id];
    box.addEventListener('change', () => { edits[note.id] = box.checked; draw(); save(); });
    li.append(box, note.text); list.append(li);
  }
}
async function save() {
  if (!folder) return;
  const file = await folder.getFileHandle('notes.edits.js', { create: true });
  const out = await file.createWritable();
  await out.write('window.NOTES_EDITS = ' + JSON.stringify(edits) + ';'); await out.close();
  document.getElementById('status').textContent = 'Saved.';
}
document.getElementById('connect').addEventListener('click', async () => {
  try {
    const picked = await window.showDirectoryPicker({ mode: 'readwrite' });
    let mine = false;
    for await (const [name] of picked.entries()) if (name === 'notes.js') mine = true;
    if (!mine) { document.getElementById('status').textContent = 'That is not the notes folder.'; return; }
    folder = picked; await save();
  } catch (e) { document.getElementById('status').textContent = 'Save failed: ' + e.message; }
});
draw();`

// The three defects of 2026-09-19, one each.
const SYNC_WALK_APP = GOOD_APP.replace('for await (const [name] of picked.entries())', 'for (const [name] of picked.entries())')
const DROPS_EDITS_APP = GOOD_APP.replace('box.checked = !!edits[note.id];', 'box.checked = !!(window.NOTES_EDITS || {})[note.id];')
  .replace("edits[note.id] = box.checked; draw(); save();", 'draw();')

// Headless Edge is the runtime this tool drives. Linux CI has no Edge: the checks that need a browser skip there
// rather than pass vacuously (same probe as check-web-app.test.js).
function edgeInstalled() {
  if (process.platform !== 'win32') return false
  return [process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.ProgramFiles ?? 'C:\\Program Files']
    .some((base) => fs.existsSync(path.join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')))
}
const needsEdge = edgeInstalled() ? {} : { skip: 'Microsoft Edge is not installed here' }
let root

function makeApp(appJs) {
  const dir = fs.mkdtempSync(path.join(root, 'app-'))
  fs.writeFileSync(path.join(dir, 'index.html'), INDEX)
  fs.writeFileSync(path.join(dir, 'notes.js'), DATA)
  fs.writeFileSync(path.join(dir, 'app.js'), appJs)
  return dir
}

function hashDir(dir) {
  const hash = crypto.createHash('sha256')
  for (const name of fs.readdirSync(dir).sort()) hash.update(name).update(fs.readFileSync(path.join(dir, name)))
  return hash.digest('hex')
}

// read/list/exists and no write: the save exercise must not need one.
const ctx = {
  fs: {
    read: (p) => fs.promises.readFile(p),
    list: (p) => fs.promises.readdir(p),
    exists: async (p) => fs.existsSync(p),
  },
  log: { warn() {} },
}

const SAVE_SCRIPT = [
  { check: '#done-a' }, { click: '#connect' }, { wait: 300 }, { check: '#done-b' }, { wait: 300 },
  { reload: true }, { expectValue: '#done-a', value: 'true' }, { expectValue: '#done-b', value: 'true' },
]

before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-app-check-save-test-')) })

after(() => fs.rmSync(root, { recursive: true, force: true }))

test('save: a page that saves correctly passes, and the folder on disk is untouched', needsEdge, async () => {
  const appDir = makeApp(GOOD_APP)
  const hashBefore = hashDir(appDir)

  const result = await handler({ appDir, saveFolder: 'app', steps: SAVE_SCRIPT }, ctx)

  assert.equal(result.success, true, result.error)
  assert.equal(result.stepsFailed, 0, JSON.stringify(result.steps))
  assert.equal(result.saveFolder.pickerCalls, 1)
  assert.equal(result.saveFolder.writes.length, 2, 'the flush on connect, then the change after it')
  assert.ok(result.saveFolder.writes.every((w) => w.file === 'notes.edits.js' && w.chars > 0))
  assert.deepEqual(result.saveFolder.servedBackToThePage, [{ file: 'notes.edits.js', times: 1 }], 'the reload got the saved file')
  assert.equal(hashDir(appDir), hashBefore, 'the check must not write into the folder it verifies')
  assert.equal(fs.existsSync(path.join(appDir, 'notes.edits.js')), false)
})

test('save: walking the folder without for-await shows up as the page\'s own failure text and no write', needsEdge, async () => {
  const result = await handler({ appDir: makeApp(SYNC_WALK_APP), saveFolder: 'app', steps: SAVE_SCRIPT }, ctx)

  assert.equal(result.saveFolder.writes.length, 0)
  assert.match(result.saveFolder.summary, /wrote nothing/)
  const reload = result.steps.find((s) => s.step === 'reload')
  assert.match(reload.newTextBeforeReload, /not iterable/)
  assert.ok(result.stepsFailed >= 1)
})

test('save: corrections dropped on redraw write an empty save, and the reload shows it', needsEdge, async () => {
  const result = await handler({ appDir: makeApp(DROPS_EDITS_APP), saveFolder: 'app', steps: SAVE_SCRIPT }, ctx)

  assert.ok(result.steps.some((s) => s.step.startsWith('expectValue #done-a') && !s.ok), JSON.stringify(result.steps))
})

test('save: a folder that is not the app\'s is refused and nothing is written into it', needsEdge, async () => {
  const result = await handler({
    appDir: makeApp(GOOD_APP), saveFolder: 'other',
    steps: [{ check: '#done-a' }, { click: '#connect' }, { wait: 300 }, { expectText: 'That is not the notes folder.' }],
  }, ctx)

  assert.equal(result.stepsFailed, 0, JSON.stringify(result.steps))
  assert.deepEqual(result.saveFolder.writesIntoTheWrongFolder, [])
  assert.match(result.saveFolder.summary, /not its own and wrote nothing/)
})

test('save: without saveFolder the page\'s picker is left alone', needsEdge, async () => {
  const result = await handler({ appDir: makeApp(GOOD_APP), steps: [{ expectText: 'first' }] }, ctx)

  assert.equal(result.success, true, result.error)
  assert.equal(result.saveFolder, undefined)
  assert.equal(result.stepsFailed, 0)
})

test('an alert does not freeze the check and is reported', needsEdge, async () => {
  const appDir = makeApp("document.getElementById('connect').addEventListener('click', () => alert('Pick the notes folder.'));")
  const result = await handler({ appDir, steps: [{ click: '#connect' }] }, ctx)

  assert.deepEqual(result.dialogs, [{ type: 'alert', message: 'Pick the notes folder.' }])
})

test('save: a page that writes into whatever folder it is handed is told so as a problem', needsEdge, async () => {
  // The report states facts; this one it also judges, because writing only into its own folder is what makes handing a
  // page a folder safe — and a model that was never told so does not read a bare list of writes as a defect.
  const trusting = GOOD_APP.replace("if (!mine) { document.getElementById('status').textContent = 'That is not the notes folder.'; return; }", '')
  const result = await handler({
    appDir: makeApp(trusting), saveFolder: 'other', steps: [{ check: '#done-a' }, { click: '#connect' }, { wait: 300 }],
  }, ctx)

  assert.equal(result.saveFolder.writesIntoTheWrongFolder.length, 1)
  assert.match(result.saveFolder.summary, /^PROBLEM: .*must check that the folder/)
})
