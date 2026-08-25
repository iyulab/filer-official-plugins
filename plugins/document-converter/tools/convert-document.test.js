const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const JSZip = require('jszip') // already vendored transitively via mammoth's own dependency
const handler = require('./convert-document.js')

function fsCtx(overrides) {
  return {
    fs: {
      read: async (filePath) => fs.promises.readFile(filePath),
      write: async (filePath, data) => fs.promises.writeFile(filePath, data),
    },
    renderHtmlToPdf: async (html) => Buffer.from(`%PDF-fake\n${html}`),
    ...overrides,
  }
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'document-converter-test-'))
  try {
    await fn(dir)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

// Built with a real zip library, not hand-typed bytes — convert-image.test.js's own precedent
// (cycle-580) found a hand-typed binary fixture was silently corrupt and wasted a debugging pass.
async function writeTestDocx(dir, bodyText) {
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>${bodyText}</w:t></w:r></w:p></w:body>
</w:document>`

  const zip = new JSZip()
  zip.file('[Content_Types].xml', contentTypes)
  zip.file('_rels/.rels', rels)
  zip.file('word/document.xml', documentXml)
  const buf = await zip.generateAsync({ type: 'nodebuffer' })

  const sourcePath = path.join(dir, 'sample.docx')
  fs.writeFileSync(sourcePath, buf)
  return sourcePath
}

test('convert_document converts docx to html', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = await writeTestDocx(dir, 'Hello from docx')
    const outputPath = path.join(dir, 'sample.html')

    const result = await handler({ path: sourcePath, targetFormat: 'html', outputPath }, fsCtx())

    assert.equal(result.success, true)
    const html = fs.readFileSync(outputPath, 'utf-8')
    assert.match(html, /Hello from docx/)
    assert.match(html, /<p>/)
  })
})

test('convert_document converts docx to markdown', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = await writeTestDocx(dir, 'Hello from docx')
    const outputPath = path.join(dir, 'sample.md')

    const result = await handler({ path: sourcePath, targetFormat: 'md', outputPath }, fsCtx())

    assert.equal(result.success, true)
    assert.match(fs.readFileSync(outputPath, 'utf-8'), /Hello from docx/)
  })
})

test('convert_document converts docx to pdf via ctx.renderHtmlToPdf', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = await writeTestDocx(dir, 'Hello from docx')
    const outputPath = path.join(dir, 'sample.pdf')
    let receivedHtml = null
    const ctx = fsCtx({ renderHtmlToPdf: async (html) => { receivedHtml = html; return Buffer.from('%PDF-1.4 fake') } })

    const result = await handler({ path: sourcePath, targetFormat: 'pdf', outputPath }, ctx)

    assert.equal(result.success, true)
    assert.match(receivedHtml, /Hello from docx/)
    assert.ok(fs.readFileSync(outputPath).toString().startsWith('%PDF'))
  })
})

test('convert_document converts markdown to html', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'sample.md')
    fs.writeFileSync(sourcePath, '# Title\n\nSome **bold** text.\n')
    const outputPath = path.join(dir, 'sample.html')

    const result = await handler({ path: sourcePath, targetFormat: 'html', outputPath }, fsCtx())

    assert.equal(result.success, true)
    const html = fs.readFileSync(outputPath, 'utf-8')
    assert.match(html, /<h1>Title<\/h1>/)
    assert.match(html, /<strong>bold<\/strong>/)
  })
})

test('convert_document converts html to markdown', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'sample.html')
    fs.writeFileSync(sourcePath, '<h1>Title</h1><p>Some <strong>bold</strong> text.</p>')
    const outputPath = path.join(dir, 'sample.md')

    const result = await handler({ path: sourcePath, targetFormat: 'md', outputPath }, fsCtx())

    assert.equal(result.success, true)
    const md = fs.readFileSync(outputPath, 'utf-8')
    assert.match(md, /Title/)
    assert.match(md, /\*\*bold\*\*/)
  })
})

test('convert_document converts html to plain text', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'sample.html')
    fs.writeFileSync(sourcePath, '<h1>Title</h1><p>First paragraph.</p><p>Second paragraph.</p>')
    const outputPath = path.join(dir, 'sample.txt')

    const result = await handler({ path: sourcePath, targetFormat: 'txt', outputPath }, fsCtx())

    assert.equal(result.success, true)
    const text = fs.readFileSync(outputPath, 'utf-8')
    assert.match(text, /Title/)
    assert.match(text, /First paragraph\./)
    assert.match(text, /Second paragraph\./)
    assert.doesNotMatch(text, /<[a-z]/)
  })
})

test('convert_document converts plain text to html', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'sample.txt')
    fs.writeFileSync(sourcePath, 'line one\nline two & <tricky> chars')
    const outputPath = path.join(dir, 'sample.html')

    const result = await handler({ path: sourcePath, targetFormat: 'html', outputPath }, fsCtx())

    assert.equal(result.success, true)
    const html = fs.readFileSync(outputPath, 'utf-8')
    assert.match(html, /<pre>/)
    assert.match(html, /line one/)
    assert.match(html, /&amp;/)
    assert.match(html, /&lt;tricky&gt;/)
  })
})

test('convert_document converts plain text to pdf', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'sample.txt')
    fs.writeFileSync(sourcePath, 'just some text')
    const outputPath = path.join(dir, 'sample.pdf')

    const result = await handler({ path: sourcePath, targetFormat: 'pdf', outputPath }, fsCtx())

    assert.equal(result.success, true)
    assert.ok(fs.existsSync(outputPath))
  })
})

test('convert_document refuses to overwrite an existing output file', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'sample.md')
    fs.writeFileSync(sourcePath, '# Title')
    const outputPath = path.join(dir, 'existing.html')
    fs.writeFileSync(outputPath, 'not a real conversion')

    const result = await handler({ path: sourcePath, targetFormat: 'html', outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /already exists/)
    assert.equal(fs.readFileSync(outputPath, 'utf-8'), 'not a real conversion')
  })
})

test('convert_document rejects an unsupported source extension (pdf)', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'sample.pdf')
    fs.writeFileSync(sourcePath, '%PDF-1.4 fake')
    const outputPath = path.join(dir, 'sample.html')

    const result = await handler({ path: sourcePath, targetFormat: 'html', outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /Unsupported source format/)
  })
})

test('convert_document rejects an unsupported target format', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'sample.md')
    fs.writeFileSync(sourcePath, '# Title')
    const outputPath = path.join(dir, 'sample.docx')

    const result = await handler({ path: sourcePath, targetFormat: 'docx', outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /Unsupported target format/)
  })
})

test('convert_document rejects converting to the same format', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'sample.md')
    fs.writeFileSync(sourcePath, '# Title')
    const outputPath = path.join(dir, 'sample2.md')

    const result = await handler({ path: sourcePath, targetFormat: 'md', outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /already in md format/)
  })
})

test('convert_document reports a clear error for a corrupt docx source, not a crash', async () => {
  await withTempDir(async (dir) => {
    const sourcePath = path.join(dir, 'corrupt.docx')
    fs.writeFileSync(sourcePath, 'this is not actually a docx file')
    const outputPath = path.join(dir, 'out.html')

    const result = await handler({ path: sourcePath, targetFormat: 'html', outputPath }, fsCtx())

    assert.equal(result.success, false)
    assert.match(result.error, /Failed to parse source document/)
    assert.ok(!fs.existsSync(outputPath), 'no partial output file should be written on parse failure')
  })
})

test('convert_document requires path, targetFormat, and outputPath', async () => {
  const result = await handler({ path: 'x.md' }, fsCtx())
  assert.equal(result.success, false)
  assert.match(result.error, /required/)
})
