// Static checks for CI: every theme script parses (as an ES module or a classic script), the version
// in theme/js/version.js matches package.json, and every $t()/plural() string has a translation in
// each locale — with no stale entries left behind.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THEME = path.join(ROOT, 'theme');
let failed = 0;
const fail = (m) => { console.error('✗ ' + m); failed++; };
const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []);

// 1. syntax
const asts = new Map();
for (const f of files(path.join(THEME, 'js'))) {
  const src = fs.readFileSync(f, 'utf8');
  try { asts.set(f, [src, acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module' })]); }
  catch (e1) {
    try { asts.set(f, [src, acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' })]); }
    catch (e2) { fail(`${path.relative(ROOT, f)}: ${e1.message}`); }
  }
}
console.log(`✓ ${asts.size} scripts parse`);

// 2. version
const ver = (fs.readFileSync(path.join(THEME, 'js', 'version.js'), 'utf8').match(/VERSION = '([^']+)'/) || [])[1];
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
if (ver !== pkg) fail(`theme/js/version.js (${ver}) ≠ package.json (${pkg})`); else console.log(`✓ version ${ver}`);
const man = JSON.parse(fs.readFileSync(path.join(THEME, 'gatefold.json'), 'utf8'));
if (man.version !== ver) fail(`theme/gatefold.json (${man.version}) ≠ theme/js/version.js (${ver})`);
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== 'v' + ver) fail(`tag ${process.env.GITHUB_REF_NAME} ≠ v${ver}`);

// 3. translations
const keys = new Set();
for (const [f, [src, ast]] of asts) {
  if (f.includes(`${path.sep}locales${path.sep}`)) continue;
  walk.full(ast, (n) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'Identifier') return;
    if (n.callee.name === '$t' && n.arguments[0]) {
      const a = n.arguments[0];
      if (a.type === 'Literal' && typeof a.value === 'string') keys.add(a.value);
    }
    if (n.callee.name === 'plural' && n.arguments.length === 4 && n.arguments.slice(1).every((a) => a.type === 'Literal')) keys.add(n.arguments.slice(1).map((a) => a.value).join('|'));
  });
}
for (const h of ['index.html', 'canvas.html']) {
  const s = fs.readFileSync(path.join(THEME, h), 'utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
  for (const m of s.matchAll(/>([^<]+)</g)) { const k = m[1].trim().replace(/\s+/g, ' '); if (/[А-Яа-яЁё]/.test(k)) keys.add(k); }
  for (const m of s.matchAll(/\b(?:title|placeholder|aria-label|alt)="([^"]*)"/g)) if (/[А-Яа-яЁё]/.test(m[1])) keys.add(m[1]);
}
const locDir = path.join(THEME, 'js', 'locales');
for (const lf of fs.readdirSync(locDir).filter((x) => x.endsWith('.js'))) {
  const mod = await import('file://' + path.join(locDir, lf));
  const dict = mod.default;
  const missing = [...keys].filter((k) => !(k in dict));
  const stale = Object.keys(dict).filter((k) => !keys.has(k));
  const badPh = Object.entries(dict).filter(([k, v]) => JSON.stringify((k.match(/\{\d+\}/g) || []).sort()) !== JSON.stringify((v.match(/\{\d+\}/g) || []).sort()));
  const badPl = Object.entries(dict).filter(([k, v]) => k.split('|').length === 3 && v.split('|').length !== 2);
  if (missing.length) fail(`${lf}: ${missing.length} untranslated — ${missing.slice(0, 5).map((x) => JSON.stringify(x)).join(', ')}`);
  if (stale.length) fail(`${lf}: ${stale.length} stale — ${stale.slice(0, 5).map((x) => JSON.stringify(x)).join(', ')}`);
  if (badPh.length) fail(`${lf}: placeholders differ — ${badPh.slice(0, 3).map(([k]) => JSON.stringify(k)).join(', ')}`);
  if (badPl.length) fail(`${lf}: plural entries must be "one|other" — ${badPl.slice(0, 3).map(([k]) => k).join(', ')}`);
  if (!missing.length && !stale.length && !badPh.length && !badPl.length) console.log(`✓ ${lf}: ${keys.size} strings translated`);
}
process.exit(failed ? 1 : 0);
