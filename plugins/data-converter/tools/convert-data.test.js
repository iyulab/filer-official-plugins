const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const handler = require('./convert-data.js');

function fsCtx() {
  return {
    fs: {
      read: async filePath => fs.promises.readFile(filePath),
      write: async (filePath, data) => fs.promises.writeFile(filePath, data),
    },
  };
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-converter-test-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('convert_data converts csv to json', async () => {
  await withTempDir(async dir => {
    const sourcePath = path.join(dir, 'sample.csv');
    fs.writeFileSync(sourcePath, 'name,amount\nAlice,100\nBob,250\n');
    const outputPath = path.join(dir, 'sample.json');

    const result = await handler({ path: sourcePath, targetFormat: 'json', outputPath }, fsCtx());

    assert.equal(result.success, true);
    assert.equal(result.path, outputPath);
    assert.equal(result.rowCount, 2);
    const written = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
    assert.deepEqual(written, [
      { name: 'Alice', amount: '100' },
      { name: 'Bob', amount: '250' },
    ]);
  });
});

test('convert_data converts json to csv', async () => {
  await withTempDir(async dir => {
    const sourcePath = path.join(dir, 'sample.json');
    fs.writeFileSync(sourcePath, JSON.stringify([{ name: 'Alice', amount: 100 }]));
    const outputPath = path.join(dir, 'sample.csv');

    const result = await handler({ path: sourcePath, targetFormat: 'csv', outputPath }, fsCtx());

    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(outputPath, 'utf-8'), 'name,amount\r\nAlice,100');
  });
});

test('convert_data converts xlsx to csv', async () => {
  await withTempDir(async dir => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ name: 'Alice', amount: 100 }]), 'Sheet1');
    const sourcePath = path.join(dir, 'sample.xlsx');
    XLSX.writeFile(workbook, sourcePath);
    const outputPath = path.join(dir, 'sample.csv');

    const result = await handler({ path: sourcePath, targetFormat: 'csv', outputPath }, fsCtx());

    assert.equal(result.success, true);
    assert.equal(fs.readFileSync(outputPath, 'utf-8'), 'name,amount\r\nAlice,100');
  });
});

test('convert_data refuses to overwrite an existing output file', async () => {
  await withTempDir(async dir => {
    const sourcePath = path.join(dir, 'sample.csv');
    fs.writeFileSync(sourcePath, 'name\nAlice\n');
    const outputPath = path.join(dir, 'existing.json');
    fs.writeFileSync(outputPath, '[]');

    const result = await handler({ path: sourcePath, targetFormat: 'json', outputPath }, fsCtx());

    assert.equal(result.success, false);
    assert.match(result.error, /already exists/);
    assert.equal(fs.readFileSync(outputPath, 'utf-8'), '[]');
  });
});

test('convert_data rejects an unsupported source extension', async () => {
  await withTempDir(async dir => {
    const sourcePath = path.join(dir, 'sample.yaml');
    fs.writeFileSync(sourcePath, 'name: Alice\n');
    const outputPath = path.join(dir, 'sample.json');

    const result = await handler({ path: sourcePath, targetFormat: 'json', outputPath }, fsCtx());

    assert.equal(result.success, false);
    assert.match(result.error, /Unsupported source format/);
  });
});

test('convert_data rejects converting to the same format as the source', async () => {
  await withTempDir(async dir => {
    const sourcePath = path.join(dir, 'sample.csv');
    fs.writeFileSync(sourcePath, 'name\nAlice\n');
    const outputPath = path.join(dir, 'sample2.csv');

    const result = await handler({ path: sourcePath, targetFormat: 'csv', outputPath }, fsCtx());

    assert.equal(result.success, false);
    assert.match(result.error, /already in csv format/);
  });
});

test('convert_data reports a clean error for missing required params', async () => {
  const result = await handler({}, fsCtx());
  assert.equal(result.success, false);
  assert.match(result.error, /required/);
});
