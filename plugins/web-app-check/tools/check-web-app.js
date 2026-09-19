/* global document, window -- the page.evaluate / init-script callbacks run in the browser */
const path = require('node:path')
const { pathToFileURL, fileURLToPath } = require('node:url')

const TEXT_LIMIT = 4000
const SETTLE_MS = 1500
const CLICK_SETTLE_MS = 400
const NAV_TIMEOUT_MS = 20000
const MAX_STEPS = 40
const MAX_WAIT_MS = 5000
const WRITE_HEAD = 300
const TEXT_BEFORE_RELOAD = 1200
const OTHER_FOLDER_NAME = 'Documents'

const STEP_ACTIONS = ['click', 'fill', 'check', 'uncheck', 'select', 'reload', 'wait', 'expectText', 'expectNoText', 'expectValue']

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
  '.svg': 'image/svg+xml',
}

function isInside(child, root) {
  const rel = path.relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more characters]` : text
}

function isNotFound(e) {
  return e.code === 'ENOENT' || /ENOENT|no such file/i.test(e.message)
}

async function launchEdge(chromium) {
  try {
    return await chromium.launch({ channel: 'msedge', headless: true })
  } catch (e) {
    const err = new Error(
      'Microsoft Edge could not be started, so the page cannot be opened. ' +
      'Edge ships with Windows; on other systems this tool is not available yet.')
    err.cause = e
    throw err
  }
}

// Visible text of the page and of every frame inside it.
async function visibleText(page, ctx) {
  const parts = []
  for (const frame of page.frames()) {
    try {
      const t = await frame.evaluate(() => (document.body ? document.body.innerText : ''))
      if (t && t.trim()) parts.push(t.trim())
    } catch (e) {
      // a frame that navigated away or was detached mid-read has nothing to add
      ctx.log.warn(`web-app-check: a frame's text could not be read: ${e.message}`)
    }
  }
  return parts.join('\n---\n')
}

async function linesOf(page, ctx) {
  return new Set((await visibleText(page, ctx)).split('\n').map((l) => l.trim()).filter(Boolean))
}

async function findInAnyFrame(page, selector) {
  for (const frame of page.frames()) {
    const handle = await frame.$(selector).catch(() => null)
    if (handle) return handle
  }
  return null
}

async function clickInAnyFrame(page, selector) {
  const handle = await findInAnyFrame(page, selector)
  if (!handle) return false
  await handle.click({ timeout: 5000 })
  return true
}

/** Validates `steps` up front, so a typo is one clear error instead of a half-run script. */
function parseSteps(raw) {
  if (raw === undefined || raw === null) return { steps: [] }
  if (!Array.isArray(raw)) return { error: 'steps must be a list' }
  if (raw.length > MAX_STEPS) return { error: `steps holds ${raw.length} entries; the limit is ${MAX_STEPS}` }
  const steps = []
  for (const [index, step] of raw.entries()) {
    const where = `steps[${index}]`
    if (!step || typeof step !== 'object' || Array.isArray(step)) return { error: `${where} must be an object such as {"click": "#save"}` }
    const actions = STEP_ACTIONS.filter((a) => step[a] !== undefined)
    if (actions.length !== 1) {
      return { error: `${where} must name exactly one action (${STEP_ACTIONS.join(', ')}); it names ${actions.length ? actions.join(' and ') : 'none'}` }
    }
    const action = actions[0]
    const target = step[action]
    if (action === 'reload') {
      if (target !== true) return { error: `${where}: write {"reload": true}` }
    } else if (action === 'wait') {
      if (typeof target !== 'number' || !(target >= 0)) return { error: `${where}: wait takes milliseconds` }
    } else if (typeof target !== 'string' || !target.trim()) {
      return { error: `${where}: ${action} takes a ${action.startsWith('expect') && action !== 'expectValue' ? 'text' : 'CSS selector'}` }
    }
    if ((action === 'fill' || action === 'select' || action === 'expectValue') && typeof step.value !== 'string') {
      return { error: `${where}: ${action} also needs "value" (a string)` }
    }
    steps.push({ action, target, value: step.value })
  }
  return { steps }
}

function describeStep(step) {
  if (step.action === 'reload') return 'reload'
  if (step.action === 'wait') return `wait ${step.target} ms`
  return step.value === undefined ? `${step.action} ${step.target}` : `${step.action} ${step.target} = ${JSON.stringify(step.value)}`
}

async function runStep(page, step, ctx) {
  const needElement = async () => {
    const handle = await findInAnyFrame(page, step.target)
    if (!handle) throw new Error('no element matches')
    return handle
  }
  switch (step.action) {
    case 'click': await (await needElement()).click({ timeout: 5000 }); break
    case 'fill': await (await needElement()).fill(step.value, { timeout: 5000 }); break
    case 'check':
    case 'uncheck': {
      // Not ElementHandle.check(): it re-reads the box after clicking, and a page that redraws its list on every change
      // (most generated ones do) has replaced the element by then. Click when the state differs; an expectValue step
      // is what verifies the outcome.
      const handle = await needElement()
      const checked = await handle.evaluate((el) => !!el.checked)
      if (checked !== (step.action === 'check')) await handle.click({ timeout: 5000 })
      break
    }
    case 'select': await (await needElement()).selectOption(step.value, { timeout: 5000 }); break
    case 'reload':
      await page.reload({ waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
      await page.waitForTimeout(SETTLE_MS)
      return
    case 'wait': await page.waitForTimeout(Math.min(step.target, MAX_WAIT_MS)); return
    case 'expectText': {
      const text = await visibleText(page, ctx)
      if (!text.includes(step.target)) throw new Error('the text is not on the page')
      return
    }
    case 'expectNoText': {
      const text = await visibleText(page, ctx)
      if (text.includes(step.target)) throw new Error('the text is on the page')
      return
    }
    case 'expectValue': {
      const handle = await needElement()
      const actual = await handle.evaluate((el) => (el.type === 'checkbox' || el.type === 'radio' ? String(el.checked) : String(el.value ?? el.textContent ?? '')))
      if (actual !== step.value) throw new Error(`the value is ${JSON.stringify(actual)}`)
      return
    }
    default: throw new Error(`unknown action ${step.action}`)
  }
  await page.waitForTimeout(CLICK_SETTLE_MS)
}

/**
 * The folder the page is handed when it asks for one. Reads come from the app folder through ctx.fs (the runtime's own
 * grant and deny rules decide, as for page loads). Writes never reach the disk: they land in `written`, and the same
 * map answers the page's own file:// requests afterwards, so a reload shows what the app saved. The check runs inside a
 * person's real folder — a probe correction written into their corrections file would be the tool corrupting what it
 * verifies.
 */
function createSaveFolder(mode, appDir, ctx) {
  const written = new Map() // relative posix path -> text
  const removed = new Set()
  const state = { pickerCalls: 0, writes: [], wrongFolderWrites: [] }
  const rel = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+/, '')
  const onDisk = (p) => {
    const abs = path.resolve(appDir, rel(p))
    if (!isInside(abs, appDir)) throw new Error(`outside the app folder: ${p}`)
    return abs
  }
  const kindOnDisk = async (p) => {
    const abs = onDisk(p)
    if (!(await ctx.fs.exists(abs))) return null
    try {
      await ctx.fs.list(abs)
      return 'directory'
    /* eslint-disable-next-line local/no-silent-catch -- list-as-probe: ctx.fs has no stat, and listing a file is what
       fails. Anything that exists and cannot be listed is handed to the page as a file; if it is not readable either,
       the page's own read of it fails and that is reported. */
    } catch (e) {
      return isNotFound(e) ? null : 'file'
    }
  }

  async function call(op, p, data) {
    if (op === 'picked') { state.pickerCalls += 1; return true }
    if (mode === 'other') {
      // An empty folder that is not the app's: whatever the page writes here it wrote into the wrong place.
      if (op === 'list') return []
      if (op === 'kind') return null
      if (op === 'read') throw new Error(`not found: ${p}`)
      if (op === 'write') { state.wrongFolderWrites.push({ file: rel(p), chars: String(data).length }); return true }
      if (op === 'remove') return true
    }
    const key = rel(p)
    if (op === 'list') {
      const names = new Set(await ctx.fs.list(onDisk(key)).catch((e) => { if (isNotFound(e)) return []; throw e }))
      const prefix = key ? `${key}/` : ''
      for (const w of written.keys()) if (w.startsWith(prefix) && !w.slice(prefix.length).includes('/')) names.add(w.slice(prefix.length))
      const entries = []
      for (const name of names) {
        const child = prefix + name
        if (removed.has(child)) continue
        entries.push({ name, kind: written.has(child) ? 'file' : await kindOnDisk(child) })
      }
      return entries.filter((e) => e.kind)
    }
    if (op === 'kind') {
      if (removed.has(key)) return null
      return written.has(key) ? 'file' : kindOnDisk(key)
    }
    if (op === 'read') {
      if (written.has(key)) return written.get(key)
      return (await ctx.fs.read(onDisk(key))).toString('utf8')
    }
    if (op === 'write') {
      onDisk(key)
      written.set(key, String(data))
      removed.delete(key)
      state.writes.push({ file: key, chars: String(data).length, head: truncate(String(data), WRITE_HEAD) })
      return true
    }
    if (op === 'create') {
      // getFileHandle(name, { create: true }) on a file that is not there: it exists from now on, empty — not yet a save.
      onDisk(key)
      if (!written.has(key)) written.set(key, '')
      removed.delete(key)
      return true
    }
    if (op === 'remove') { written.delete(key); removed.add(key); return true }
    throw new Error(`unknown folder operation ${op}`)
  }

  return {
    state,
    call,
    /** What the page's own request for a file inside the app folder should get, when the app has written or removed it. */
    overlayFor(absolute) {
      const key = path.relative(appDir, absolute).replace(/\\/g, '/')
      if (removed.has(key)) return { missing: true }
      return written.has(key) ? { body: written.get(key) } : null
    },
  }
}

/** Runs in the page before any of its scripts: a directory handle that speaks the File System Access API over `__filerCheckFolder`. */
function installPicker(folderName) {
  const call = (...args) => window.__filerCheckFolder(...args)
  const join = (dir, name) => (dir ? `${dir}/${name}` : name)
  const notFound = (name) => new DOMException(`A requested file or directory could not be found at the time an operation was processed: ${name}`, 'NotFoundError')
  const mismatch = (name) => new DOMException(`The path supplied exists, but was not an entry of requested type: ${name}`, 'TypeMismatchError')
  const permissions = { async queryPermission() { return 'granted' }, async requestPermission() { return 'granted' } }

  const fileHandle = (dir, name) => ({
    kind: 'file',
    name,
    ...permissions,
    async isSameEntry(other) { return !!other && other.kind === 'file' && other.__path === join(dir, name) },
    __path: join(dir, name),
    async getFile() { return new File([await call('read', join(dir, name))], name) },
    async createWritable(options) {
      let text = options && options.keepExistingData ? await call('read', join(dir, name)).catch(() => '') : ''
      let position = options && options.keepExistingData ? text.length : 0
      const put = async (data) => {
        const chunk = typeof data === 'string' ? data : await new Blob([data]).text()
        text = text.slice(0, position) + chunk + text.slice(position + chunk.length)
        position += chunk.length
      }
      return {
        async write(data) {
          if (data && typeof data === 'object' && !(data instanceof Blob) && !ArrayBuffer.isView(data) && !(data instanceof ArrayBuffer) && data.type) {
            if (data.type === 'truncate') { text = text.slice(0, data.size || 0); position = Math.min(position, text.length); return }
            if (data.type === 'seek') { position = data.position || 0; return }
            if (data.position !== undefined) position = data.position
            return put(data.data)
          }
          return put(data)
        },
        async seek(to) { position = to },
        async truncate(size) { text = text.slice(0, size || 0); position = Math.min(position, text.length) },
        async close() { await call('write', join(dir, name), text) },
        async abort() { /* nothing was handed over yet */ },
      }
    },
  })

  const directoryHandle = (dir, name) => {
    const child = (entry) => (entry.kind === 'file' ? fileHandle(dir, entry.name) : directoryHandle(join(dir, entry.name), entry.name))
    const handle = {
      kind: 'directory',
      name,
      ...permissions,
      __path: dir,
      async isSameEntry(other) { return !!other && other.kind === 'directory' && other.__path === dir },
      async resolve(other) { return other && typeof other.__path === 'string' && other.__path.startsWith(dir) ? other.__path.slice(dir.length).split('/').filter(Boolean) : null },
      async getFileHandle(entryName, options) {
        const kind = await call('kind', join(dir, entryName))
        if (kind === 'directory') throw mismatch(entryName)
        if (!kind && !(options && options.create)) throw notFound(entryName)
        if (!kind) await call('create', join(dir, entryName))
        return fileHandle(dir, entryName)
      },
      async getDirectoryHandle(entryName, options) {
        const kind = await call('kind', join(dir, entryName))
        if (kind === 'file') throw mismatch(entryName)
        if (!kind && !(options && options.create)) throw notFound(entryName)
        return directoryHandle(join(dir, entryName), entryName)
      },
      async removeEntry(entryName) {
        if (!(await call('kind', join(dir, entryName)))) throw notFound(entryName)
        await call('remove', join(dir, entryName))
      },
      async * entries() { for (const entry of await call('list', dir)) yield [entry.name, child(entry)] },
      async * keys() { for (const entry of await call('list', dir)) yield entry.name },
      async * values() { for (const entry of await call('list', dir)) yield child(entry) },
    }
    handle[Symbol.asyncIterator] = handle.entries
    return handle
  }

  window.showDirectoryPicker = async () => {
    await call('picked')
    return directoryHandle('', folderName)
  }
}

/**
 * Opens a page from a folder in headless Edge, the way a person opens it by double-clicking (file://), drives it, and
 * reports what they would see. Every file the page asks for is checked through ctx.fs.read — the runtime's own grant,
 * folder boundary and deny rules decide — and then loaded by the browser as usual, so file:// behaves exactly as it
 * does for the user. Anything else (network, a file the rules refuse) is aborted and listed.
 */
module.exports = async function handler(params, ctx) {
  const appDir = typeof params.appDir === 'string' ? path.resolve(params.appDir) : ''
  if (!appDir) return { success: false, error: 'appDir is required' }
  const pageRel = typeof params.page === 'string' && params.page.trim() ? params.page.trim() : 'index.html'
  const pagePath = path.resolve(appDir, pageRel)
  if (!isInside(pagePath, appDir)) return { success: false, error: `page must be inside appDir: ${pageRel}` }
  const clicks = Array.isArray(params.clicks) ? params.clicks.filter((s) => typeof s === 'string' && s.trim()) : []
  const parsed = parseSteps(params.steps)
  if (parsed.error) return { success: false, error: parsed.error }
  const saveMode = params.saveFolder
  if (saveMode !== undefined && saveMode !== 'app' && saveMode !== 'other') {
    return { success: false, error: 'saveFolder is "app" (the app\'s own folder) or "other" (a folder that is not the app\'s)' }
  }
  if (saveMode && typeof ctx.fs.exists !== 'function') {
    return { success: false, error: 'This version of Filer cannot run the save exercise (it needs a newer plugin runtime).' }
  }

  try {
    await ctx.fs.read(pagePath)
  } catch (e) {
    return { success: false, error: `Cannot open ${pageRel}: ${e.message}` }
  }

  const { chromium } = require('playwright-core')
  let browser
  try {
    browser = await launchEdge(chromium)
  } catch (e) {
    return { success: false, error: e.message }
  }

  const pageErrors = []
  const consoleErrors = []
  const blocked = []
  const missing = []
  const dialogs = []
  const clickResults = []
  const stepResults = []
  const folder = saveMode ? createSaveFolder(saveMode, appDir, ctx) : null
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
    if (folder) {
      await context.exposeBinding('__filerCheckFolder', async (_source, op, p, data) => folder.call(op, p, data))
      await context.addInitScript(installPicker, saveMode === 'app' ? path.basename(appDir) : OTHER_FOLDER_NAME)
    }
    await context.route('**/*', async (route) => {
      const url = route.request().url()
      if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('about:')) return route.continue()
      if (url.startsWith('file:')) {
        let local
        try {
          local = fileURLToPath(url)
        } catch (e) {
          ctx.log.warn(`web-app-check: unreadable file URL ${url}: ${e.message}`)
          local = null
        }
        if (local && isInside(local, appDir)) {
          const overlay = folder ? folder.overlayFor(local) : null
          if (overlay && overlay.missing) return route.abort('filenotfound')
          if (overlay) {
            return route.fulfill({ status: 200, contentType: CONTENT_TYPES[path.extname(local).toLowerCase()] ?? 'application/octet-stream', body: overlay.body })
          }
          try {
            await ctx.fs.read(local)
            return route.continue()
          } catch (e) {
            const shown = path.relative(appDir, local) || local
            if (isNotFound(e)) {
              // The page asked for a file that is not there — what the user's browser would also fail on.
              ctx.log.warn(`web-app-check: the page asked for a missing file: ${shown}`)
              missing.push(shown)
              return route.continue() // the browser fails on it natively, as it does for the user
            }
            ctx.log.warn(`web-app-check: the page asked for a file the folder rules refuse: ${e.message}`)
            blocked.push({ url: shown, reason: e.message })
            return route.abort('accessdenied')
          }
        }
        blocked.push({ url: local ?? url, reason: 'outside appDir' })
        return route.abort('accessdenied')
      }
      blocked.push({ url, reason: 'network access is blocked' })
      return route.abort('blockedbyclient')
    })

    const page = await context.newPage()
    page.on('pageerror', (e) => pageErrors.push(e.message))
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
    // An unanswered alert/confirm freezes the page. Answer yes and report what it said: a person would read it.
    page.on('dialog', (d) => {
      dialogs.push({ type: d.type(), message: d.message() })
      d.accept().catch((e) => ctx.log.warn(`web-app-check: a dialog could not be answered: ${e.message}`))
    })

    await page.goto(pathToFileURL(pagePath).href, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
    await page.waitForTimeout(SETTLE_MS)
    let loadedLines = await linesOf(page, ctx)

    for (const selector of clicks) {
      try {
        const found = await clickInAnyFrame(page, selector)
        clickResults.push({ selector, clicked: found, ...(found ? {} : { error: 'no element matches' }) })
      } catch (e) {
        ctx.log.warn(`web-app-check: click on ${selector} failed: ${e.message}`)
        clickResults.push({ selector, clicked: false, error: e.message })
      }
      await page.waitForTimeout(CLICK_SETTLE_MS)
    }

    for (const step of parsed.steps) {
      // A reload wipes whatever the page said about the save it just tried ("Saved", "Save failed: …") — keep it.
      // Only the lines that were not there when the page (last) loaded: the status line, not the whole screen again.
      let before = {}
      if (step.action === 'reload') {
        const fresh = (await visibleText(page, ctx)).split('\n').map((l) => l.trim()).filter((l) => l && !loadedLines.has(l))
        before = { newTextBeforeReload: truncate(fresh.join('\n'), TEXT_BEFORE_RELOAD) }
      }
      try {
        await runStep(page, step, ctx)
        if (step.action === 'reload') loadedLines = await linesOf(page, ctx)
        stepResults.push({ step: describeStep(step), ok: true, ...before })
      } catch (e) {
        const reason = e.message.split('\n')[0]
        ctx.log.warn(`web-app-check: step "${describeStep(step)}" failed: ${reason}`)
        stepResults.push({ step: describeStep(step), ok: false, error: reason, ...before })
      }
    }

    const title = await page.title()
    const text = await visibleText(page, ctx)
    const notes = []
    if (folder && [...pageErrors, ...consoleErrors].some((m) => /DataCloneError|could not be cloned/i.test(m))) {
      notes.push('The folder this check hands the page cannot be stored in IndexedDB, unlike a real one. An error about cloning it is a limit of the check, not a defect of the page.')
    }

    return {
      success: true,
      page: pageRel,
      title,
      text: truncate(text, TEXT_LIMIT),
      textLength: text.length,
      pageErrors,
      consoleErrors,
      ...(clickResults.length ? { clicks: clickResults } : {}),
      ...(stepResults.length ? { steps: stepResults, stepsFailed: stepResults.filter((s) => !s.ok).length } : {}),
      ...(dialogs.length ? { dialogs } : {}),
      ...(folder
        ? {
            saveFolder: {
              handed: saveMode === 'app' ? "the app's own folder" : `another, empty folder named "${OTHER_FOLDER_NAME}"`,
              summary: summarizeSave(saveMode, folder.state),
              pickerCalls: folder.state.pickerCalls,
              writes: folder.state.writes,
              ...(saveMode === 'other' ? { writesIntoTheWrongFolder: folder.state.wrongFolderWrites } : {}),
              note: 'Nothing was written to disk: the page\'s writes were kept aside and served back to it, so a reload step shows what it saved.',
            },
          }
        : {}),
      ...(notes.length ? { notes } : {}),
      missing,
      blocked,
    }
  } catch (e) {
    return { success: false, error: `The page could not be checked: ${e.message}`, pageErrors, consoleErrors, blocked }
  } finally {
    await browser.close().catch((e) => ctx.log.warn(`web-app-check: browser close failed: ${e.message}`))
  }
}

/** One sentence a reader can act on; the lists beside it are the evidence. */
function summarizeSave(mode, state) {
  if (state.pickerCalls === 0) return 'The page never asked for a folder — no step reached its connect/save control, or the control does not call showDirectoryPicker.'
  if (mode === 'other') {
    return state.wrongFolderWrites.length
      ? `The page accepted a folder that is not its own and wrote ${state.wrongFolderWrites.length} file(s) into it.`
      : 'The page was handed a folder that is not its own and wrote nothing into it.'
  }
  return state.writes.length
    ? `The page was handed its folder and wrote ${state.writes.length} time(s). Whether what it wrote is right is for the steps after a reload to show.`
    : 'The page was handed its folder and wrote nothing. Look at pageErrors and at the text before the reload for what it said.'
}

module.exports.parseSteps = parseSteps
