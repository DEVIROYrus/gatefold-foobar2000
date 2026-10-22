/*
 * Gatefold · album-details.js — «Details» on an album page (off by default; the «Details» button,
 * a click on the album's track count, or the I key).
 *
 *   facts    a card in the empty right part of the album header: format, bitrate, size, loudness
 *            (from ReplayGain), dynamic range (foo_dr_meter), plays and when it was added
 *            (foo_playcount), release date, label and catalogue number, genres, discs, the folder.
 *            Only what the album actually has is shown, at most nine, most useful first.
 *   columns  the track list gains format, bitrate, loudness, DR and plays — again only the columns
 *            this album has values for; the artist column goes when every track has the album's artist.
 * Everything comes from one titleformat.evalFieldsBatch call for the album's tracks.
 */
import { call, ok, esc, fmtTime } from './bridge.js';
import { $t, num, locale, plural } from './i18n.js';

/* title formatting: [...] leaves a field that is not there empty (instead of «?») */
const TF = {
  bits: '[%__bitspersample%]', prof: '[%codec_profile%]', enc: '[%__encoding%]',
  dr: '[$if2(%dynamic range%,%dr%)]', adr: '[%album dynamic range%]',
  tg: '[%replaygain_track_gain%]', ag: '[%replaygain_album_gain%]', ap: '[%replaygain_album_peak%]',
  plays: '[%play_count%]', last: '[%last_played%]', added: '[%added%]',
  date: '[%date%]', odate: '[$if2(%original release date%,%originaldate%)]',
  label: '[$if2(%publisher%,%label%)]', cat: '[$if2(%catalognumber%,%catalog #%)]', genre: '[%genre%]',
};
const LOSSLESS = /^(flac|alac|ape|monkey|wavpack|wv|tta|tak|pcm|wav|aiff|dsd|dsf|dff|mlp|truehd|shorten|ofr|optimfrog)/i;

/** per-track values (same order as `tracks`) */
export async function load(tracks) {
  const paths = tracks.map((t) => t.handle || (t.subsong ? `${t.absolutePath}|subsong:${t.subsong}` : t.absolutePath));
  const r = await call('titleformat.evalFieldsBatch', { paths, fields: TF });
  const rows = ok(r) ? r.results || [] : [];
  return tracks.map((t, i) => {
    const x = (rows[i] && rows[i].success !== false && rows[i]) || {};
    const f = (k) => { const v = String(x[k] ?? '').trim(); return v === '?' ? '' : v; };
    const n = (k) => { const v = parseFloat(f(k).replace(',', '.')); return Number.isFinite(v) ? v : null; };
    return {
      bits: n('bits'), prof: f('prof'), lossless: /lossless/i.test(f('enc')) || LOSSLESS.test(t.codec || ''),
      dr: n('dr'), adr: n('adr'), tg: n('tg'), ag: n('ag'), ap: n('ap'),
      plays: n('plays'), last: f('last'), added: f('added'),
      date: f('date'), odate: f('odate'), label: f('label'), cat: f('cat'), genre: f('genre'),
    };
  });
}

/* ---------------------------------------------------------------- formatting */
const khz = (hz) => num(hz / 1000, { maximumFractionDigits: 1 });
const kbps = (v) => num(Math.round(v));
const lufsOf = (gain) => (gain == null ? null : -18 - gain);
const minus = (t) => String(t).replace(/^-/, '−');                 // a real minus sign, not a hyphen
const fmtLufs = (v) => minus(num(v, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
function fmtSize(bytes) {
  // a unit up from 1000 of the one below («0.99 GB», not «1,010.1 MB»)
  const u = [[1 << 30, $t('ГБ')], [1 << 20, $t('МБ')], [1 << 10, $t('КБ')]];
  for (const [d, name] of u) if (bytes >= d * 1000 / 1024) return `${num(bytes / d, { maximumFractionDigits: bytes / d < 10 ? 2 : 1 })} ${name}`;
  return `${num(bytes)} B`;
}
/** «2003-02-10» → a date in the interface language; a bare year stays a year */
function fmtDate(s) {
  const m = String(s || '').match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  if (!m) return '';
  if (!m[2]) return m[1];
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +(m[3] || 1)));
  return new Intl.DateTimeFormat(locale, m[3] ? { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' } : { year: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
}
/** «2024-03-12 21:33:01» → «2 days ago» / «3 months ago» */
function ago(s) {
  const t = Date.parse(String(s || '').replace(' ', 'T'));
  if (!Number.isFinite(t)) return '';
  const sec = (t - Date.now()) / 1000, rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const a = Math.abs(sec);
  if (a < 3600) return rtf.format(Math.round(sec / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
  if (a < 86400 * 45) return rtf.format(Math.round(sec / 86400), 'day');
  if (a < 86400 * 548) return rtf.format(Math.round(sec / (86400 * 30.4)), 'month');
  return rtf.format(Math.round(sec / (86400 * 365.25)), 'year');
}
const uniq = (arr) => [...new Set(arr.filter((v) => v != null && v !== ''))];
const median = (arr) => { const a = arr.filter((v) => v != null).sort((x, y) => x - y); return a.length ? a[(a.length - 1) >> 1] : null; };
const range = (arr, f) => { const a = arr.filter((v) => v != null && v > 0); if (!a.length) return ''; const lo = Math.min(...a), hi = Math.max(...a); return lo === hi ? f(lo) : `${f(lo)}–${f(hi)}`; };

/** the format of one track, short: «FLAC 24/96», «MP3 V0», «Opus» */
export function trackFormat(t, x) {
  const c = t.codec || '';
  if (x && x.lossless && t.sampleRate) return x.bits ? `${c} ${x.bits}/${khz(t.sampleRate)}` : `${c} · ${khz(t.sampleRate)} ${$t('кГц')}`;
  const p = x && x.prof && !/^(lossless|lossy)$/i.test(x.prof) ? ' ' + x.prof.replace(/^VBR\s+/i, '') : '';
  return c + p;
}
const chName = (n) => (n === 1 ? $t('моно') : n === 2 ? '' : n === 6 ? '5.1' : n === 8 ? '7.1' : n ? $t('{0} кан.', n) : '');

/* ---------------------------------------------------------------- the facts card */
/** [{ k: label, v: html, title?, wide?, act? }] — what this album has, most useful first */
export function facts(a, tracks, ext) {
  const out = [];
  const add = (k, v, extra = {}) => { if (v) out.push({ k, v, ...extra }); };
  const total = tracks.reduce((s, t) => s + (t.duration || 0), 0);
  // format: codecs; the resolution of the lossless ones; channels when not stereo
  const codecs = uniq(tracks.map((t) => t.codec));
  const lossless = ext.some((x) => x.lossless);
  const bits = uniq(ext.map((x) => x.bits)), rates = uniq(tracks.map((t) => t.sampleRate));
  // short in the card («FLAC 24/96», the way audio people write it), spelled out on hover
  const oneBits = bits.length === 1 && bits[0];
  const res = lossless && oneBits && rates.length ? `${oneBits}/${range(rates, khz)}` : '';
  const resHz = !res && rates.length ? `${range(rates, khz)} ${$t('кГц')}` : '';
  const resLong = rates.length ? `${bits.length === 1 && bits[0] ? bits[0] + ' ' + $t('бит') + ' · ' : ''}${range(rates, khz)} ${$t('кГц')}` : '';
  const ch = uniq(tracks.map((t) => t.channels)).map(chName).filter(Boolean).join(', ');
  add($t('Формат'), esc([[codecs.join(', '), res].filter(Boolean).join(' '), resHz, ch].filter(Boolean).join(' · ')), { title: [codecs.join(', '), resLong, ch].filter(Boolean).join(' · ') });
  // bitrate: the average weighted by length, or the spread of a lossy album with mixed rates
  const brs = tracks.map((t) => t.bitrate || 0);
  if (brs.some((b) => b > 0)) {
    const avg = tracks.reduce((s, t) => s + (t.bitrate || 0) * (t.duration || 0), 0) / (total || 1);
    const lo = Math.min(...brs.filter((b) => b > 0)), hi = Math.max(...brs);
    add($t('Битрейт'), lossless || hi - lo > hi * 0.15 ? `≈ ${kbps(avg || hi)} ${$t('кбит/с')}${!lossless ? `<small>${kbps(lo)}–${kbps(hi)}</small>` : ''}` : `${kbps(hi)} ${$t('кбит/с')}`);
  }
  const size = tracks.reduce((s, t) => s + (t.fileSize > 0 ? t.fileSize : 0), 0);
  if (size > 0) add($t('Размер'), esc(fmtSize(size)));
  // loudness: the album's ReplayGain value (−18 LUFS reference), or the median of the tracks'
  const ag = median(ext.map((x) => x.ag)), tg = median(ext.map((x) => x.tg));
  const L = lufsOf(ag != null ? ag : tg);
  if (L != null) add($t('Громкость\u0004loudness'), `${fmtLufs(L)} LUFS${ag == null ? `<small>${$t('по трекам')}</small>` : ''}`, { title: $t('Интегральная громкость по EBU R128, из значения ReplayGain') });
  const dr = median(ext.map((x) => x.adr)) ?? median(ext.map((x) => x.dr));
  if (dr != null) add($t('Динамика'), `DR${Math.round(dr)}`, { title: $t('Динамический диапазон (foo_dr_meter): чем больше, тем меньше сжат звук') });
  const plays = ext.reduce((s, x) => s + (x.plays || 0), 0), anyPlays = ext.some((x) => x.plays != null);
  const last = ext.map((x) => x.last).filter(Boolean).sort().pop();
  if (anyPlays) add($t('Прослушивания'), plays ? `${num(plays)}${last ? `<small>${esc(ago(last))}</small>` : ''}` : $t('ещё не слушали'), last ? { title: last } : {});
  const added = ext.map((x) => x.added).filter(Boolean).sort()[0];
  if (added) add($t('Добавлен'), esc(fmtDate(added.slice(0, 10))), { title: added });
  // release: a full date, or the original release when it differs from the year shown above
  const date = uniq(ext.map((x) => x.date))[0] || '', odate = uniq(ext.map((x) => x.odate))[0] || '';
  const year = (String(a.year || '').match(/\d{4}/) || [''])[0];
  if (odate && odate.slice(0, 4) !== year) add($t('Первый выпуск'), esc(fmtDate(odate)));
  if (/^\d{4}-\d{2}/.test(date)) add($t('Выпуск'), esc(fmtDate(date)));
  const label = uniq(ext.map((x) => x.label))[0], cat = uniq(ext.map((x) => x.cat))[0];
  if (label || cat) add($t('Лейбл'), `${esc(label || '')}${cat ? `<small>${esc(cat)}</small>` : ''}`, { title: [label, cat].filter(Boolean).join(' · ') });
  const genres = uniq(ext.flatMap((x) => String(x.genre || '').split(/\s*[;,/]\s*/)));
  if (genres.length > 1 || (genres[0] && genres[0] !== a.genre)) add(plural(genres.length, 'Жанр', 'Жанры', 'Жанры'), esc(genres.slice(0, 4).join(', ')), { title: genres.join(', ') });
  const discs = uniq(tracks.map((t) => t.discNumber || 0)).length;
  if (discs > 1) add($t('Диски'), num(discs));
  const shown = out.slice(0, 9);
  // the folder, as wide as the card: the end of the path, the whole one on hover, a click opens it
  const p = String(a.firstTrackAbsolutePath || tracks[0]?.absolutePath || '');
  const dir = p.replace(/[\\/][^\\/]*$/, '');
  if (dir) {
    const parts = dir.split(/[\\/]/).filter(Boolean);
    const tail = parts.length > 2 ? '…\\' + parts.slice(-2).join('\\') : dir;
    shown.push({ k: $t('Папка'), v: esc(tail), title: dir, wide: true, act: 'folder' });
  }
  return shown;
}

export function factsHtml(list) {
  return list.map((f) => `<div class="f${f.wide ? ' wide' : ''}${f.act ? ' act' : ''}"${f.act ? ` data-act="${f.act}" role="button" tabindex="0"` : ''}${f.title ? ` title="${esc(f.title)}"` : ''}><div class="k">${esc(f.k)}</div><div class="v">${f.v}</div></div>`).join('');
}

/* ---------------------------------------------------------------- the detailed track list */
/** the columns this album has values for → { cols: CSS grid template, head: html, cell(t, x): html } */
/** `extra`: your own columns (columns.js), put before the heart's gap and the time */
export function columns(a, tracks, ext, extra = []) {
  const albumArtist = (a.albumArtist || a.artist || '').toLowerCase();
  const showArtist = tracks.some((t) => String(t.artist || '').toLowerCase() !== albumArtist);
  const has = (f) => ext.some((x) => x[f] != null);
  const C = [];
  C.push({ w: '44px', head: '#', cls: 'c-n num', cell: (t, x, i) => t.trackNumber || i + 1 });
  C.push({ w: 'minmax(0, 1.6fr)', head: $t('Название'), cls: 'c-title', cell: (t) => esc(t.title) });
  if (showArtist) C.push({ w: 'minmax(0, 1fr)', head: $t('Исполнитель'), cls: 'c-artist', cell: (t) => esc(t.artist) });
  C.push({ w: showArtist ? 'minmax(84px, .8fr)' : 'minmax(84px, 1fr)', head: $t('Формат'), cls: 'c-fmt', cell: (t, x) => esc(trackFormat(t, x)) });
  if (tracks.some((t) => t.bitrate > 0)) C.push({ w: '64px', head: $t('кбит/с'), cls: 'c-x num', cell: (t) => (t.bitrate > 0 ? kbps(t.bitrate) : '') });
  if (has('tg')) C.push({ w: '58px', head: 'LUFS', title: $t('Громкость трека по EBU R128, из значения ReplayGain'), cls: 'c-x num', cell: (t, x) => (x.tg != null ? fmtLufs(lufsOf(x.tg)) : '') });
  if (has('dr')) C.push({ w: '42px', head: 'DR', title: $t('Динамический диапазон (foo_dr_meter)'), cls: 'c-x num', cell: (t, x) => (x.dr != null ? Math.round(x.dr) : '') });
  if (has('plays')) C.push({ w: '44px', head: '▶', title: $t('Прослушивания'), cls: 'c-x num', cell: (t, x) => (x.plays ? num(x.plays) : '') });
  C.push(...extra);
  C.push({ w: '34px', head: '', cls: 'c-gap', cell: () => '' });            // the heart button sits here
  C.push({ w: '58px', head: $t('Время'), cls: 'c-dur num', cell: (t) => fmtTime(t.duration) });
  return {
    cols: C.map((c) => c.w).join(' '),
    head: C.map((c) => `<div class="${c.cls}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.head)}</div>`).join(''),
    cells: C,
  };
}
