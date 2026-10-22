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

// 2b. vendored onnxruntime-web = the version in package.json (the models' .wasm is fetched for that version)
const ortVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).devDependencies['onnxruntime-web'];
for (const f of ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs']) {
  const nm = path.join(ROOT, 'node_modules', 'onnxruntime-web', 'dist', f);
  if (fs.existsSync(nm) && !fs.readFileSync(nm).equals(fs.readFileSync(path.join(THEME, 'js', 'vendor', 'ort', f)))) fail(`theme/js/vendor/ort/${f} differs from onnxruntime-web ${ortVer}`);
}
if (!/ORT_VERSION = '([^']+)'/.test(fs.readFileSync(path.join(ROOT, 'tools', 'ml', 'build_assets.py'), 'utf8')) || RegExp.$1 !== ortVer) fail(`tools/ml/build_assets.py ORT_VERSION ≠ onnxruntime-web ${ortVer}`);

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
for (const h of ['index.html', 'canvas.html', 'mini.html']) {
  const s = fs.readFileSync(path.join(THEME, h), 'utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, '');
  for (const m of s.matchAll(/>([^<]+)</g)) { const k = m[1].trim().replace(/\s+/g, ' '); if (/[А-Яа-яЁё]/.test(k)) keys.add(k); }
  for (const m of s.matchAll(/\sdata-ctx="([^"]*)"[^>]*>([^<]+)</g)) keys.add(m[2].trim().replace(/\s+/g, ' ') + '\u0004' + m[1]);
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
  if (missing.length) fail(`${lf}: ${missing.length} untranslated — ${missing.slice(0, process.env.ALL ? 9999 : 5).map((x) => JSON.stringify(x)).join(', ')}`);
  if (stale.length && process.argv.includes('--prune')) {
    // node tools/check.mjs --prune: drop entries no source string uses any more
    const file = path.join(locDir, lf), drop = new Set(stale.map((k) => JSON.stringify(k)));
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => { const m = l.match(/^\s*("(?:[^"\\]|\\.)*")\s*:/); return !(m && drop.has(m[1])); });
    fs.writeFileSync(file, lines.join('\n').replace(/,(\s*\n};)/, '$1'));
    console.log(`✓ ${lf}: pruned ${stale.length} unused strings`); stale.length = 0;
  }
  if (stale.length) fail(`${lf}: ${stale.length} stale — ${stale.slice(0, 5).map((x) => JSON.stringify(x)).join(', ')}`);
  if (badPh.length) fail(`${lf}: placeholders differ — ${badPh.slice(0, 3).map(([k]) => JSON.stringify(k)).join(', ')}`);
  if (badPl.length) fail(`${lf}: plural entries must be "one|other" — ${badPl.slice(0, 3).map(([k]) => k).join(', ')}`);
  if (!missing.length && !stale.length && !badPh.length && !badPl.length) console.log(`✓ ${lf}: ${keys.size} strings translated`);
}
// 4. the loudness meter against BS.1770 reference values (loudness-core.js)
{
  const LC = await import('file://' + path.join(THEME, 'js', 'loudness-core.js'));
  const run = (fs, ch, secs, gen) => {
    const m = new LC.Meter(fs, ch), n = Math.round(fs * secs), step = 4096;
    for (let o = 0; o < n; o += step) {
      const k = Math.min(step, n - o), planes = [];
      for (let c = 0; c < ch; c++) { const a = new Float32Array(k); for (let i = 0; i < k; i++) a[i] = gen((o + i) / fs, c); planes.push(a); }
      m.push(planes, k);
    }
    return m.result();
  };
  const sine = (A) => (t) => A * Math.sin(2 * Math.PI * 997 * t);
  const cases = [
    ['997 Hz, −20 dBFS stereo, 48 kHz = −20 LUFS', run(48000, 2, 6, sine(0.1)).lufs, -20, 0.02],
    ['997 Hz, −20 dBFS stereo, 44.1 kHz = −20 LUFS', run(44100, 2, 6, sine(0.1)).lufs, -20, 0.02],
    ['mono is measured as dual mono', run(48000, 1, 6, sine(0.1)).lufs, -20, 0.02],
    ['0 dBFS on one channel = −3.01 LUFS', run(48000, 2, 6, (t, c) => (c ? 0 : Math.sin(2 * Math.PI * 997 * t))).lufs, -3.01, 0.02],
    ['relative gate: a part 20 LU quieter does not count', run(48000, 2, 12, (t) => (t < 6 ? 0.1 : 0.01) * Math.sin(2 * Math.PI * 997 * t)).lufs, -20, 0.15],
    ['true peak between samples (fs/4 at 45°)', run(48000, 2, 1, (t) => Math.sin(2 * Math.PI * 12000 * t + Math.PI / 4)).truePeak, 1, 0.01],
  ];
  const al = LC.album([run(48000, 2, 30, sine(0.316)), run(48000, 2, 6, sine(0.01))]);
  cases.push(['album: one gating over every track (a quiet interlude keeps its place)', al.lufs, -10, 0.05]);
  const bad = cases.filter(([, v, want, tol]) => !(Math.abs(v - want) <= tol));
  for (const [name, v, want] of bad) fail(`loudness: ${name} — got ${v}, want ${want}`);
  if (!bad.length) console.log(`✓ loudness meter: ${cases.length} reference checks`);
}

// 5. the radio's decisions (radio-core.js) on a library like the one that went wrong: a Finnish rock
//    seed; related artists that sound a little different; and artists that sound *closer* but are
//    another music altogether (K-pop, J-rock, thrash) — only the content points to those
{
  const RC = await import('file://' + path.join(THEME, 'js', 'radio-core.js'));
  const bad = [];
  const want = (name, cond, info = '') => { if (!cond) bad.push(name + (info ? ' — ' + info : '')); };
  // versions and fillers
  const ok = (title, album = 'Album', du = 220, seed = null) => RC.songCheck({ title, album, duration: du }, seed).ok;
  want('a remix stays out', !ok("Crush 'Em [Jock mix] [bonus track]"));
  want('a remaster is the song', ok('Still Standing (Remastered 2023)'));
  want('a radio edit is the song', ok('In the Shadows - Radio Edit'));
  want('a bonus track is a song', ok('Livin\' in a World Without You [bonus track]'));
  want('live stays out…', !ok('In the Shadows (Live)'));
  want('…unless the seed is live', ok('In the Shadows (Live)', 'Album', 220, { title: 'Guilty (Live)', album: 'Live 2003' }));
  want('a live album stays out', !ok('Guilty', 'Live at Wacken'));
  want('intros and interludes stay out', !ok('Intro') && !ok('Interlude', 'Album', 200) && !ok('Night (Interlude)'));
  want('short pieces stay out', !ok('Song', 'Album', 60));
  want('the same song on another album is spotted', RC.songKey('Still Standing (Remastered)') === RC.songKey('Still Standing'));
  want('genre similarity: shared rare genres count', RC.genreSim(new Map([['gothic rock', 1], ['alternative rock', 0.8]]), new Map([['gothic rock', 1], ['love metal', 0.6]])) > 0.4);
  want('genre similarity: nothing shared = 0', RC.genreSim(new Map([['gothic rock', 1]]), new Map([['k-pop', 1]])) === 0);

  // the library
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const A = {
    'him':            { deezer: 1, lb: 0.8, genre: 0.55, sound: 0.45, style: 0.6, era: 0.9 },
    'sunrise avenue': { deezer: 0.95, genre: 0.6, sound: 0.55, style: 0.55, era: 0.9 },
    'poets of the fall': { deezer: 0.9, lb: 0.6, genre: 0.5, sound: 0.5, style: 0.5 },
    'negative':       { deezer: 0.85, genre: 0.6, sound: 0.5, style: 0.5 },
    'lordi':          { deezer: 0.8, genre: 0.3, sound: 0.3, style: 0.3 },
    'apocalyptica':   { deezer: 0.75, genre: 0.3, sound: 0.2, style: 0.25 },
    'nightwish':      { deezer2: 0.5, lb: 0.5, genre: 0.25, sound: 0.2, style: 0.3 },
    'evanescence':    { lb: 0.7, genre: 0.45, sound: 0.55, style: 0.5 },
    'linkin park':    { lb: 0.6, genre: 0.35, sound: 0.6, style: 0.45 },
    '30 seconds to mars': { lb: 0.55, pl: 0.4, genre: 0.4, sound: 0.6, style: 0.5 },
    // close in sound, another music: only the content points to them
    'kiss of life':   { genre: 0.02, sound: 0.95, style: 0.4 },
    'gacharic spin':  { genre: 0.15, sound: 0.85, style: 0.5 },
    'maximum the hormone': { genre: 0.1, sound: 0.7, style: 0.3 },
    'megadeth':       { genre: 0.05, sound: 0.3, style: 0.2 },
    'bumblefoot':     { genre: 0.1, sound: 0.4, style: 0.2 },
    'kartsy':         { sound: 0.75, style: 0.35 },
    'avantasia':      { deezer2: 0.3, genre: 0.12, sound: 0.15, style: 0.2 },
    'pure reason revolution': { genre: 0.1, sound: 0.4, style: 0.3 },
  };
  for (let i = 0; i < 40; i++) A['filler ' + i] = { genre: rnd() * 0.3, sound: rnd() * 0.6, style: rnd() * 0.5 };
  const TRAPS = ['kiss of life', 'gacharic spin', 'maximum the hormone', 'megadeth', 'bumblefoot', 'kartsy', 'pure reason revolution'];
  const pool = Object.entries(A).map(([key, f]) => ({ key, name: key, ...RC.artistScore(f), why: [] })).filter((p) => p.s >= 0.1).sort((a, b) => b.s - a.s);
  want('artists only the sound points to, against the genre, are not on the radio', !pool.some((p) => ['kiss of life', 'gacharic spin', 'megadeth', 'maximum the hormone'].includes(p.key)), pool.map((p) => p.key).join(', '));
  const titles = ['Song', 'Ballad', 'Anthem', 'Night', 'Fire', 'Shadow', 'Rain', 'Heart', 'Run (Remix)', 'Intro', 'Live Wire (Live)', 'Echo'];
  const tracksOf = (key) => {
    const f = A[key] || { sound: 0.5 };
    return titles.map((t, i) => ({ h: key + '/' + i, title: key === 'the rasmus' ? t + ' R' : t + ' ' + key, album: key + ' ' + ['I', 'II', 'III', 'IV'][Math.floor(i / 3)], duration: 200 + i,
      sim: RC.clamp01((f.sound ?? 0.5) + (rnd() - 0.5) * 0.4), pop: i < 4 ? 1 - i * 0.2 : 0, plays: null }));
  };
  let traps = 0, total = 0, firsts = new Set();
  const top8 = new Set(pool.slice(0, 8).map((p) => p.key));
  for (let run = 0; run < 20; run++) {
    const P = new RC.Planner({ pool, seed: { key: 'the rasmus', track: { h: 'seed', title: 'Still Standing', album: 'Rise', duration: 200 } }, tracksOf, rnd });
    const out = [];
    for (let i = 0; i < 24; i++) { const x = await P.next(); if (!x) break; out.push(x); }
    total += out.length;
    traps += out.filter((x) => TRAPS.includes(x.key)).length;
    const keys = ['the rasmus', ...out.map((x) => x.key)];
    want(`run ${run}: never the same artist twice in a row`, keys.every((k, i) => !i || k !== keys[i - 1]));
    const cnt = {}; for (const k of keys) cnt[k] = (cnt[k] || 0) + 1;
    const cap = pool.length >= 14 ? 2 : 3;
    want(`run ${run}: at most ${cap} tracks of an artist (the seed's ~1 in 8)`, Object.entries(cnt).every(([k, n]) => n <= (k === 'the rasmus' ? 4 : cap)), JSON.stringify(cnt));
    const albs = out.filter((x) => x.key !== 'the rasmus').map((x) => x.key + '|' + x.t.album);
    want(`run ${run}: one song per album`, new Set(albs).size === albs.length, albs.join(', '));
    want(`run ${run}: the seed's artist comes back`, (cnt['the rasmus'] || 0) >= 3);
    want(`run ${run}: no remix, live version or intro`, out.every((x) => !/Remix|Live|Intro/.test(x.t.title)));
    want(`run ${run}: the first tracks come from the closest artists`, out.slice(0, 6).every((x) => top8.has(x.key) || x.key === 'the rasmus'), out.slice(0, 6).map((x) => x.key).join(', '));
    want(`run ${run}: 24 tracks`, out.length === 24, String(out.length));
  }
  want('tracks of artists that only sound alike stay rare', traps / total <= 0.02, `${traps} of ${total}`);
  // a library with little that fits: the radio stops instead of filling up with anything
  const small = { 'him': A['him'], 'negative': A['negative'], 'kiss of life': A['kiss of life'], 'gacharic spin': A['gacharic spin'], 'megadeth': A['megadeth'] };
  const sp = Object.entries(small).map(([key, f]) => ({ key, name: key, ...RC.artistScore(f), why: [] })).filter((p) => p.s >= 0.1);
  const P2 = new RC.Planner({ pool: sp, seed: { key: 'the rasmus', track: { h: 'seed', title: 'Still Standing', album: 'Rise', duration: 200 } }, tracksOf: (k) => tracksOf(k).slice(0, 4), rnd });
  const out2 = []; for (let i = 0; i < 24; i++) { const x = await P2.next(); if (!x) break; out2.push(x); }
  want('little that fits: the radio stops rather than playing what does not', out2.length < 24 && !out2.some((x) => TRAPS.includes(x.key)), out2.map((x) => x.key).join(', '));
  // the cases of the real radios (a seed of one scene, a library of everything)
  const S = (f) => RC.artistScore(f).s;
  want('only your playlists relate it, and the genres say otherwise: out (K-ON in a rock radio)', S({ pl: 1, genre: 0.05, sound: 0.8, style: 0.4 }) === 0);
  want('only ListenBrainz relates it, the genres say otherwise: out (Ozzy on a HIM radio)', S({ lb: 0.6, genre: 0.08, sound: 0.4, style: 0.3 }) === 0);
  want('Deezer and ListenBrainz both relate it: in, though held back by the genres', S({ deezer: 0.9, lb: 0.6, genre: 0.08, sound: 0.4, style: 0.3 }) > 0.1 && S({ deezer: 0.9, lb: 0.6, genre: 0.08, sound: 0.4, style: 0.3 }) < S({ deezer: 0.9, lb: 0.6, genre: 0.5, sound: 0.4, style: 0.3 }) * 0.6);
  want('your playlists and the genres agree: in', S({ pl: 0.8, genre: 0.5, sound: 0.5, style: 0.5 }) > 0.1);
  want('playlists weigh less than the services', S({ pl: 0.9, genre: 0.5, sound: 0.5, style: 0.5 }) < S({ deezer: 0.9, genre: 0.5, sound: 0.5, style: 0.5 }) * 0.7);
  want('related-of-related and ListenBrainz alone do not override the genres (Iron Maiden on a HIM radio)', S({ deezer2: 0.8, lb: 0.6, genre: 0.05, sound: 0.4, style: 0.3 }) === 0);
  want('the famous count less as evidence', S({ lb: 0.6, genre: 0.3, sound: 0.5, style: 0.5, fame: 0.4 }) < S({ lb: 0.6, genre: 0.3, sound: 0.5, style: 0.5 }) * 0.8);
  want('an artist on every radio is held back', S({ deezer: 0.5, genre: 0.3, sound: 0.5, style: 0.5, hub: 0.6 }) < S({ deezer: 0.5, genre: 0.3, sound: 0.5, style: 0.5 }));
  // a skipped artist comes up less
  for (const b of bad) fail('radio: ' + b);
  if (!bad.length) console.log(`✓ radio: versions, scores and 20 simulated radios (${traps} of ${total} tracks from sound-alike strangers)`);
}

process.exit(failed ? 1 : 0);
