// Every ctx capability a plugin's code calls must be declared in its manifest's `permissions` — an undeclared one
// still exists on ctx and throws "<plugin> denied: … (not-declared)" at run time (docs/PLUGIN-MANIFEST.md
// § permissions). A handler's own tests hand it a plain ctx, so only this cross-check sees the gap
// (image-describer's describe_image shipped to a live check without `ai.complete`).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;

// capability → [pattern in code, is it declared in this manifest's permissions]
const CAPABILITIES = [
  ['ai.complete', /\.ai\.complete\s*\(/, (p) => p.ai?.complete === true],
  ['store', /\bctx\.store\b/, (p) => p.store === true],
  ['hostTrigger (triggerInbound)', /\.triggerInbound\s*\(/, (p) => p.hostTrigger === true],
  ['renderHtmlToPdf', /\.renderHtmlToPdf\s*\(/, (p) => p.renderHtmlToPdf === true],
  ['session.sendMessage', /\.session\.sendMessage\s*\(/, (p) => p.session?.sendMessage === true],
  ['session.getActive', /\.session\.getActive\s*\(/, (p) => p.session?.getActive === true],
  ['fs.write', /\bctx\.fs\.write\s*\(/, (p) => p.fs?.write != null],
];

function sourcesOf(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesOf(full));
    else if (/\.(c|m)?js$/.test(entry.name) && !/\.test\.(c|m)?js$/.test(entry.name)) out.push(full);
  }
  return out;
}

const plugins = fs.readdirSync(ROOT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, d.name, 'filer-plugin.json')))
  .map((d) => d.name);

test('the cross-check sees every bundled plugin', () => {
  assert.ok(plugins.length >= 10, `found ${plugins.length} plugins under ${ROOT}`);
});

for (const name of plugins) {
  test(`${name}: every ctx capability its code calls is declared`, () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, name, 'filer-plugin.json'), 'utf8'));
    const permissions = manifest.permissions ?? {};
    const missing = [];
    for (const file of sourcesOf(path.join(ROOT, name))) {
      const code = fs.readFileSync(file, 'utf8');
      for (const [capability, pattern, declared] of CAPABILITIES) {
        if (pattern.test(code) && !declared(permissions)) missing.push(`${capability} (${path.relative(ROOT, file)})`);
      }
    }
    assert.deepEqual(missing, [], `undeclared in ${name}/filer-plugin.json permissions`);
  });
}
