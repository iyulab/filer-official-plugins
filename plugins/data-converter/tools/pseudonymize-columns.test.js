const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const handler = require('./pseudonymize-columns.js');

function fsCtx() {
  return {
    fs: {
      read: async filePath => fs.promises.readFile(filePath),
      write: async (filePath, data) => fs.promises.writeFile(filePath, data),
      exists: async filePath => fs.existsSync(filePath),
    },
  };
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pseudonymize-test-'));
  try {
    await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const people = 'name,email,city,amount\nAlice Kim,alice@example.com,Seoul,100\nBob Lee,bob@example.com,Busan,250\nAlice Kim,alice@example.com,Seoul,40\n,,Daegu,10\n';

test('the same value gets the same pseudonym within a column, empty cells stay empty, other columns are untouched', async () => {
  await withTempDir(async dir => {
    const source = path.join(dir, 'customers.csv');
    fs.writeFileSync(source, people);

    const result = await handler({ path: source, columns: ['name', 'email'], outputFolder: dir }, fsCtx());

    assert.equal(result.success, true);
    assert.equal(result.path, path.join(dir, 'customers.pseudonymized.csv'));
    assert.equal(result.keyPath, path.join(dir, 'customers.pseudonymized.key.csv'));
    assert.equal(result.rowCount, 4);
    assert.equal(result.pseudonymCount, 4);
    const lines = fs.readFileSync(result.path, 'utf-8').split(/\r?\n/);
    assert.deepEqual(lines, [
      'name,email,city,amount',
      'name-0001,email-0001,Seoul,100',
      'name-0002,email-0002,Busan,250',
      'name-0001,email-0001,Seoul,40',
      ',,Daegu,10',
    ]);
    assert.equal(fs.readFileSync(source, 'utf-8'), people, 'the source is not changed');
  });
});

test('the key file maps every pseudonym back to its value', async () => {
  await withTempDir(async dir => {
    const source = path.join(dir, 'customers.csv');
    fs.writeFileSync(source, people);

    const result = await handler({ path: source, columns: ['name'], outputFolder: dir }, fsCtx());

    assert.deepEqual(fs.readFileSync(result.keyPath, 'utf-8').split(/\r?\n/), [
      'column,pseudonym,original',
      'name,name-0001,Alice Kim',
      'name,name-0002,Bob Lee',
    ]);
  });
});

test('an unknown column is refused with the columns the file has, and nothing is written', async () => {
  await withTempDir(async dir => {
    const source = path.join(dir, 'customers.csv');
    fs.writeFileSync(source, people);

    const result = await handler({ path: source, columns: ['Name'], outputFolder: dir }, fsCtx());

    assert.equal(result.success, false);
    assert.match(result.error, /No column named "Name"/);
    assert.match(result.error, /"name", "email", "city", "amount"/);
    assert.deepEqual(fs.readdirSync(dir), ['customers.csv']);
  });
});

test('an existing copy or key file is never overwritten', async () => {
  await withTempDir(async dir => {
    const source = path.join(dir, 'customers.csv');
    fs.writeFileSync(source, people);
    fs.writeFileSync(path.join(dir, 'customers.pseudonymized.key.csv'), 'keep me');

    const result = await handler({ path: source, columns: ['name'], outputFolder: dir }, fsCtx());

    assert.equal(result.success, false);
    assert.match(result.error, /already exists/);
    assert.equal(fs.readFileSync(path.join(dir, 'customers.pseudonymized.key.csv'), 'utf-8'), 'keep me');
  });
});

test('an Excel file gets an Excel copy with its column order kept, and a column name with spaces makes a readable prefix', async () => {
  await withTempDir(async dir => {
    const source = path.join(dir, 'staff.xlsx');
    const sheet = XLSX.utils.json_to_sheet([
      { 'Full name': 'Alice Kim', Team: 'Ops' },
      { 'Full name': 'Bob Lee', Team: 'Ops' },
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, 'Sheet1');
    fs.writeFileSync(source, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));

    const result = await handler({ path: source, columns: ['Full name'], outputFolder: dir }, fsCtx());

    assert.equal(result.success, true);
    assert.equal(path.extname(result.path), '.xlsx');
    const read = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(result.path)).Sheets.Sheet1);
    assert.deepEqual(read, [
      { 'Full name': 'Full_name-0001', Team: 'Ops' },
      { 'Full name': 'Full_name-0002', Team: 'Ops' },
    ]);
  });
});

test('no columns named is refused', async () => {
  const result = await handler({ path: 'x.csv', columns: [], outputFolder: '.' }, fsCtx());
  assert.equal(result.success, false);
  assert.match(result.error, /at least one column/);
});

// A small model passed the source file as outputFolder and got "EEXIST: file already exists, mkdir '…customers.csv'".
test('outputFolder naming a data file is refused with the folder to pass instead', async () => {
  await withTempDir(async dir => {
    const source = path.join(dir, 'customers.csv');
    fs.writeFileSync(source, people);

    const result = await handler({ path: source, columns: ['name'], outputFolder: source }, fsCtx());

    assert.equal(result.success, false);
    assert.match(result.error, /outputFolder must be a folder/);
    assert.ok(result.error.includes(`pass outputFolder: ${dir}`), result.error);
    assert.deepEqual(fs.readdirSync(dir), ['customers.csv']);
  });
});

// A small model pseudonymized the copy it had just made, leaving customers.pseudonymized.pseudonymized.csv and a second key.
test('a pseudonymized copy or its key is not pseudonymized again', async () => {
  await withTempDir(async dir => {
    const source = path.join(dir, 'customers.csv');
    fs.writeFileSync(source, people);
    const first = await handler({ path: source, columns: ['name'], outputFolder: dir }, fsCtx());
    assert.equal(first.success, true);

    for (const again of [first.path, first.keyPath]) {
      const result = await handler({ path: again, columns: ['name'], outputFolder: dir }, fsCtx());
      assert.equal(result.success, false);
      assert.match(result.error, /already a pseudonymized copy/);
    }
    assert.deepEqual(fs.readdirSync(dir).sort(), ['customers.csv', 'customers.pseudonymized.csv', 'customers.pseudonymized.key.csv']);
  });
});
