// Format conversion helpers for document-converter. Every source format converts to an HTML
// intermediate first (mammoth for docx, marked for md, identity for html, escape+wrap for txt);
// every target format then reads from that same HTML — one conversion path per format, not a
// combinatorial matrix of direct pairwise converters.

const ENTITY_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
function escapeHtml(text) {
  return text.replace(/[&<>]/g, (ch) => ENTITY_MAP[ch])
}

async function docxToHtml(buffer) {
  const mammoth = require('mammoth')
  const result = await mammoth.convertToHtml({ buffer })
  return result.value
}

function mdToHtml(markdown) {
  const { marked } = require('marked')
  return marked.parse(markdown)
}

function htmlToMd(html) {
  const TurndownService = require('turndown')
  const turndown = new TurndownService()
  return turndown.turndown(html)
}

function txtToHtml(text) {
  // <pre> preserves whitespace/line breaks faithfully — a plain text file has no other
  // structure to render, and this is also what feeds ->pdf for a txt source.
  return `<pre>${escapeHtml(text)}</pre>`
}

// Best-effort text extraction, not a full HTML parser: strips tags, turns common block-level
// closes into newlines so paragraphs/headings don't run together, decodes the handful of
// entities this plugin's own HTML intermediate can actually produce. Documented v1
// simplification — matches image-converter's GIF-quantization precedent (codecs.js).
function htmlToText(html) {
  return html
    .replace(/<\/(p|div|h[1-6]|li|tr|pre)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Converts a source buffer/string to an HTML intermediate. Returns null for a source format
// with no HTML path (there are none today, but keeps the dispatch table shape honest).
async function toHtmlIntermediate(sourceExt, content) {
  switch (sourceExt) {
    case 'docx':
      return docxToHtml(content)
    case 'md':
      return mdToHtml(content.toString('utf-8'))
    case 'html':
      return content.toString('utf-8')
    case 'txt':
      return txtToHtml(content.toString('utf-8'))
    default:
      return null
  }
}

module.exports = { toHtmlIntermediate, htmlToMd, htmlToText, escapeHtml }
