// Pick the presets Gatefold ships, from the measurements of analyze.py (see there for the steps).
//   out: no preset that flashes (whole picture or a region: WCAG 2.3.1, < 3 flashes a second — with margin),
//        none that failed, stays near-black, barely moves or is a flat fill;
//   in:  each marked calm / flow / vivid by its motion and how much its light changes;
//   the best of each kind by a score that likes colour, detail and a balanced brightness.
// node tools/milkdrop/select.mjs [metrics.json] → theme/js/vendor/milkdrop/presets.json
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([a-z]:)/i, '$1'));
const ROOT = path.resolve(HERE, '..', '..');
const metrics = JSON.parse(fs.readFileSync(process.argv[2] || path.join(HERE, 'metrics.json'), 'utf8'));
const PACKS = ['butterchurnPresets.min.js', 'butterchurnPresetsExtra.min.js', 'butterchurnPresetsExtra2.min.js', 'butterchurnPresetsMD1.min.js'];
globalThis.self = globalThis; globalThis.window = globalThis;
const all = {};
for (const f of PACKS) { const m = require(path.join(ROOT, 'node_modules', 'butterchurn-presets', 'lib', f)); Object.assign(all, (m.default || m).getPresets()); }

const rows = Object.entries(metrics).filter(([n, m]) => all[n] && !m.err).map(([n, m]) => ({ n, ...m }));
const keep = rows.filter((r) =>
  r.flash < 0.6 && r.flashLocal < 1.2 &&          // well below 3 flashes a second, in the whole picture and in any region
  r.dark < 0.72 &&                                 // not a near-black screen
  r.lum > 0.02 && r.lum < 0.62 &&                  // neither empty nor a white-out
  r.lumVar < 0.15 &&                              // no big pulsing of the whole picture
  r.motion > 0.004 &&                              // it moves
  r.detail > 0.025);                               // not a flat fill
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mo = keep.map((r) => r.motion + r.lumVar * 2);
const lo = q(mo, 0.4), hi = q(mo, 0.78);
for (const r of keep) {
  const e = r.motion + r.lumVar * 2;
  r.c = e <= lo ? 'calm' : e >= hi ? 'vivid' : 'flow';
  if (r.chroma > 0.55 && r.c !== 'vivid') r.c = 'vivid';        // acid colours are not calm, however slowly they move
  // colour and detail are what make a preset beautiful; a brightness around a quarter is easiest on the eyes
  r.score = r.chroma * 1.4 + r.detail * 2 - Math.abs(r.lum - 0.22) * 1.2 - r.dark * 0.4 - r.flashLocal * 0.15;
}
const PER = { calm: 34, flow: 40, vivid: 26 };
const out = [];
for (const c of Object.keys(PER)) out.push(...keep.filter((r) => r.c === c).sort((a, b) => b.score - a.score).slice(0, PER[c]));
out.sort((a, b) => a.n.localeCompare(b.n));
const file = path.join(ROOT, 'theme', 'js', 'vendor', 'milkdrop', 'presets.json');
fs.writeFileSync(file, JSON.stringify({ v: 1, source: 'butterchurn-presets 2.4.7, measured by tools/milkdrop', presets: out.map((r) => ({ n: r.n, c: r.c, p: all[r.n] })) }));
const by = (c) => out.filter((r) => r.c === c).length;
console.log(`${rows.length} measured, ${keep.length} pass, ${out.length} kept (calm ${by('calm')}, flow ${by('flow')}, vivid ${by('vivid')}), ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
