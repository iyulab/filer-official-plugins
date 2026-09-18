/* global document, window -- the page.evaluate callbacks run in the browser */
const path = require('node:path')
const { pathToFileURL, fileURLToPath } = require('node:url')

const TEXT_LIMIT = 4000
const SETTLE_MS = 1500
const CLICK_SETTLE_MS = 400
const NAV_TIMEOUT_MS = 20000

function isInside(child, root) {
  const rel = path.relative(root, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function truncate(text, limit) {
  return text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more characters]` : text
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

// Visible text of the page and of every frame inside it (a generated UI often renders in a sandboxed iframe).
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

async function clickInAnyFrame(page, selector) {
  for (const frame of page.frames()) {
    const handle = await frame.$(selector).catch(() => null)
    if (handle) {
      await handle.click({ timeout: 5000 })
      return true
    }
  }
  return false
}

/**
 * Opens a page from a folder in headless Edge, the way a person opens it by double-clicking (file://),
 * and reports what they would see. Every file the page asks for is checked through ctx.fs.read — the
 * runtime's own grant, folder boundary and deny rules decide — and then loaded by the browser as usual,
 * so file:// behaves exactly as it does for the user. Anything else (network, a file the rules refuse)
 * is aborted and listed.
 */
module.exports = async function handler(params, ctx) {
  const appDir = typeof params.appDir === 'string' ? path.resolve(params.appDir) : ''
  if (!appDir) return { success: false, error: 'appDir is required' }
  const pageRel = typeof params.page === 'string' && params.page.trim() ? params.page.trim() : 'index.html'
  const pagePath = path.resolve(appDir, pageRel)
  if (!isInside(pagePath, appDir)) return { success: false, error: `page must be inside appDir: ${pageRel}` }
  const clicks = Array.isArray(params.clicks) ? params.clicks.filter((s) => typeof s === 'string' && s.trim()) : []

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
  const clickResults = []
  try {
    const context = await browser.newContext({ serviceWorkers: 'block' })
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
          try {
            await ctx.fs.read(local)
            return route.continue()
          } catch (e) {
            const shown = path.relative(appDir, local) || local
            if (e.code === 'ENOENT' || /ENOENT|no such file/i.test(e.message)) {
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

    await page.goto(pathToFileURL(pagePath).href, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
    await page.waitForTimeout(SETTLE_MS)

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

    const title = await page.title()
    const text = await visibleText(page, ctx)
    // A host shell may collect faults its sandboxed UI reported (vivarium onFault) under this name.
    const appFaults = await page.evaluate(() => (Array.isArray(window.__appFaults) ? window.__appFaults.slice(0, 50) : null))
      .catch(() => null)

    return {
      success: true,
      page: pageRel,
      title,
      text: truncate(text, TEXT_LIMIT),
      textLength: text.length,
      pageErrors,
      consoleErrors,
      ...(appFaults ? { appFaults } : {}),
      ...(clickResults.length ? { clicks: clickResults } : {}),
      missing,
      blocked,
    }
  } catch (e) {
    return { success: false, error: `The page could not be checked: ${e.message}`, pageErrors, consoleErrors, blocked }
  } finally {
    await browser.close().catch((e) => ctx.log.warn(`web-app-check: browser close failed: ${e.message}`))
  }
}
