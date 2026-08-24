const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const handler = require('./read-data-file.js');

function fsCtx() {
  return {
    fs: {
      read: async filePath => fs.promises.readFile(filePath),
    },
  };
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-analyzer-test-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('read_data_file parses .xlsx into rows/columns from the first sheet', async () => {
  await withTempDir(async dir => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([
      { name: 'Alice', amount: 100 },
      { name: 'Bob', amount: 250 },
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Invoices');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ note: 'unused' }]), 'Notes');
    const filePath = path.join(dir, 'invoices.xlsx');
    XLSX.writeFile(workbook, filePath);

    const result = await handler({ path: filePath }, fsCtx());

    assert.equal(result.success, true);
    assert.equal(result.format, 'xlsx');
    assert.equal(result.sheetName, 'Invoices');
    assert.deepEqual(result.sheetNames, ['Invoices', 'Notes']);
    assert.deepEqual(result.columns, ['name', 'amount']);
    assert.equal(result.rowCount, 2);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.data, [
      { name: 'Alice', amount: 100 },
      { name: 'Bob', amount: 250 },
    ]);
  });
});

test('read_data_file truncates .xlsx rows past maxRows', async () => {
  await withTempDir(async dir => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ id: i }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Sheet1');
    const filePath = path.join(dir, 'many-rows.xlsx');
    XLSX.writeFile(workbook, filePath);

    const result = await handler({ path: filePath, maxRows: 2 }, fsCtx());

    assert.equal(result.success, true);
    assert.equal(result.rowCount, 5);
    assert.equal(result.truncated, true);
    assert.equal(result.data.length, 2);
  });
});

test('read_data_file returns Excel date cells as Date values, not raw serial numbers', async () => {
  await withTempDir(async dir => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([{ name: 'Alice', dueDate: new Date(Date.UTC(2025, 0, 15)) }]);
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
    const filePath = path.join(dir, 'dated.xlsx');
    XLSX.writeFile(workbook, filePath);

    const result = await handler({ path: filePath }, fsCtx());

    assert.equal(result.success, true);
    assert.ok(result.data[0].dueDate instanceof Date, 'expected a Date instance, not a raw serial number');
    assert.equal(result.data[0].dueDate.toISOString().slice(0, 10), '2025-01-15');
  });
});

test('read_data_file still parses .csv unaffected by the xlsx branch', async () => {
  await withTempDir(async dir => {
    const filePath = path.join(dir, 'sample.csv');
    fs.writeFileSync(filePath, 'name,amount\nAlice,100\nBob,250\n');

    const result = await handler({ path: filePath }, fsCtx());

    assert.equal(result.success, true);
    assert.equal(result.format, 'csv');
    assert.deepEqual(result.columns, ['name', 'amount']);
    assert.equal(result.rowCount, 2);
  });
});

test('read_data_file reports a clean error for a missing path', async () => {
  const result = await handler({}, fsCtx());
  assert.equal(result.success, false);
  assert.match(result.error, /path is required/);
});
