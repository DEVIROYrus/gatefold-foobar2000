/*
 * Gatefold · columns.js — your own track-list columns, written in foobar2000's title formatting.
 *
 * Like Default UI's custom columns: any tag or any title formatting script (%performer%, %genre%,
 * $if2(%label%,%publisher%), your own fields…) becomes a column of the playlist view, of the album
 * page, or both. Each column has a name, a pattern, a width and an alignment (numbers are put on the
 * right by themselves). Values come from foobar2000 itself (titleformat.evalFieldsBatch), a page of
 * tracks at a time, so a 50 000-track playlist costs nothing until it is scrolled.
 *
 * Settings → Playlists → «Columns» edits them, with a live preview on the playing track; a right
 * click on a list's header (or its ⋯ button) switches them on and off for that list.
 */
import { call, ok, esc, debounce } from './bridge.js';
import { settings, setSetting } from './settings.js';
import { h, icon, popupMenu, router } from './ui.js';
import { $t } from './i18n.js';

export const events = new EventTarget();
const emit = () => events.dispatchEvent(new Event('change'));

/* ready-made columns: the tags people most often add */
export const PRESETS = () => [
  { name: $t('Жанр'), tf: '%genre%' },
  { name: $t('Год'), tf: '$year(%date%)', w: 's' },
  { name: $t('Исполнитель трека'), tf: '%performer%' },
  { name: $t('Композитор'), tf: '%composer%' },
  { name: $t('Исполнитель альбома'), tf: '%album artist%' },
  { name: $t('Рейтинг'), tf: '$if(%rating%,$repeat(★,%rating%),)', w: 's' },
  { name: $t('Прослушиваний'), tf: '%play_count%', w: 's' },
  { name: $t('Последнее прослушивание'), tf: '%last_played%' },
  { name: $t('Добавлен'), tf: '%added%' },
  { name: $t('Формат'), tf: '%codec%[ %__bitspersample%/$div(%samplerate%,1000)]' },
  { name: $t('Битрейт'), tf: '[%bitrate% kbps]', w: 's' },
  { name: 'BPM', tf: '%bpm%', w: 's' },
  { name: $t('Лейбл'), tf: '$if2(%label%,%publisher%)' },
  { name: $t('Комментарий'), tf: '%comment%', w: 'l' },
  { name: 'ReplayGain', tf: '[%replaygain_album_gain%]', w: 's' },
];

const uid = () => 'c' + Math.random().toString(36).slice(2, 9);
const valid = (c) => c && typeof c.tf === 'string' && c.tf.trim();
/** every column (in order) */
export const all = () => (Array.isArray(settings.trackColumns) ? settings.trackColumns : []).filter(valid);
/** the columns a list shows: 'pl' (playlists) or 'al' (album page) */
export const forView = (v) => all().filter((c) => c[v] !== false);
function save(list) { setSetting('trackColumns', list.map(({ id, name, tf, w, align, pl, al }) => ({ id, name, tf, w, align, pl, al }))); emit(); }
export function add(c) { const list = all().slice(); const x = { id: uid(), name: c.name || '', tf: c.tf, w: c.w || 'm', align: c.align || 'auto', pl: c.pl !== false, al: c.al !== false }; list.push(x); save(list); return x; }
export function update(id, patch) { save(all().map((c) => (c.id === id ? { ...c, ...patch } : c))); }
export function remove(id) { save(all().filter((c) => c.id !== id)); }
export function move(id, d) {
  const list = all().slice(), i = list.findIndex((c) => c.id === id), j = i + d;
  if (i < 0 || j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]]; save(list);
}

/* ---------------------------------------------------------------- look */
const NUMERIC = /%(bitrate|play_count|bpm|tracknumber|discnumber|totaltracks|totaldiscs|rating|samplerate|__bitspersample|channels|filesize|length_seconds|date|year|replaygain_\w+)%/i;
/** 'left' | 'right' | 'center' — 'auto' puts a pattern of numbers on the right */
export function alignOf(c) {
  if (c.align && c.align !== 'auto') return c.align;
  const rest = c.tf.replace(/%[^%]*%/g, '').replace(/\$\w+\(/g, '(').replace(/'[^']*'/g, '');
  return NUMERIC.test(c.tf) && !/\p{L}{2,}/u.test(rest) ? 'right' : 'left';
}
const WIDTH = { s: 'minmax(52px, .45fr)', m: 'minmax(0, .8fr)', l: 'minmax(0, 1.3fr)' };
/** the grid tracks of the columns, for grid-template-columns */
export const gridOf = (cols) => cols.map((c) => WIDTH[c.w] || WIDTH.m).join(' ');
const cls = (c) => 'c-cx' + ({ right: ' r', center: ' m' }[alignOf(c)] || '');
export const cellClass = cls;
/** header cells */
export const headHtml = (cols) => cols.map((c) => `<div class="h-cx${alignOf(c) === 'right' ? ' r' : alignOf(c) === 'center' ? ' m' : ''}" title="${esc(c.tf)}">${esc(c.name || c.tf)}</div>`).join('');
/** empty cells of a row (filled by fill()) */
export const emptyCells = (cols) => cols.map((c, i) => `<div class="${cls(c)}" data-cx="${i}"></div>`).join('');
/** row cells with their values */
export const cellsHtml = (cols, vals) => cols.map((c, i) => { const v = (vals && vals[i]) || ''; return `<div class="${cls(c)}" data-cx="${i}"${v.length > 18 ? ` title="${esc(v)}"` : ''}>${esc(v)}</div>`; }).join('');
/** put values into a row's empty cells */
export function fill(row, vals) {
  for (const el of row.querySelectorAll('[data-cx]')) {
    const v = (vals && vals[+el.dataset.cx]) || '';
    el.textContent = v;
    if (v.length > 18) el.title = v; else el.removeAttribute('title');
  }
}

/* ---------------------------------------------------------------- values */
// a lone field shows nothing (not «?») when the track has no such tag
const pattern = (tf) => { const t = tf.trim(); return /^%[^%]+%$/.test(t) ? `[${t}]` : t; };
const clean = (v) => { const s = String(v ?? '').trim(); return s === '?' ? '' : s; };
async function evalBatch(paths, cols) {
  const fields = {}; cols.forEach((c, i) => { fields['c' + i] = pattern(c.tf); });
  const r = await call('titleformat.evalFieldsBatch', { paths, fields });
  if (!ok(r)) return null;
  const rows = r.results || [];
  return paths.map((_, k) => cols.map((c, i) => clean(rows[k] && rows[k]['c' + i])));
}
/** the columns' values of these tracks (paths with |subsong:N) → [[v0, v1, …], …] */
export async function values(paths, cols) {
  if (!cols.length || !paths.length) return paths.map(() => []);
  const out = [];
  for (let i = 0; i < paths.length; i += 500) {
    const part = paths.slice(i, i + 500);
    let v = await evalBatch(part, cols);
    if (!v) {
      // one pattern foobar2000 cannot compile fails the whole call: the others still show
      const each = await Promise.all(cols.map((c) => evalBatch(part, [c])));
      v = part.map((_, k) => cols.map((c, j) => (each[j] ? each[j][k][0] : '')));
    }
    out.push(...v);
  }
  return out;
}

/* ---------------------------------------------------------------- the header menu */
/** right click on a list header / its ⋯ button: switch columns for this list, or edit them */
export async function headerMenu(view, x, y) {
  const list = all();
  const items = list.map((c) => ({ id: 't:' + c.id, label: c.name || c.tf, checked: c[view] !== false }));
  if (items.length) items.push({ type: 'sep' });
  const used = new Set(list.map((c) => c.tf.trim()));
  const free = PRESETS().filter((p) => !used.has(p.tf));
  if (free.length) items.push({ id: 'add', label: $t('Добавить колонку'), children: free.map((p, i) => ({ id: 'p:' + i, label: p.name })) });
  items.push({ id: 'edit', label: $t('Настроить колонки…') });
  const id = await popupMenu(items, x, y);
  if (!id) return;
  if (id === 'edit') return openEditor();
  if (id.startsWith('t:')) { const c = list.find((q) => q.id === id.slice(2)); if (c) update(c.id, { [view]: c[view] === false }); return; }
  if (id.startsWith('p:')) { const p = free[+id.slice(2)]; if (p) add({ ...p, pl: view === 'pl', al: view === 'al' }); }
}
export function openEditor() {
  router.go('settings');
  setTimeout(() => { const el = document.getElementById('cxEditor'); if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1400); } }, 150);
}

/* ---------------------------------------------------------------- the editor (Settings → Playlists) */
async function sampleTrack() {
  const c = await call('playback.getCurrentTrack');
  const t = ok(c) && c.found !== false ? (c.track || c) : null;
  if (t && (t.absolutePath || t.path)) return { path: (t.subsong ? `${t.absolutePath || t.path}|subsong:${t.subsong}` : t.absolutePath || t.path), title: t.title || '' };
  const r = await call('library.query', { query: 'ALL', limit: 1, fields: ['absolutePath', 'subsong', 'title'] });
  const x = ok(r) && r.tracks && r.tracks[0];
  return x ? { path: x.subsong ? `${x.absolutePath}|subsong:${x.subsong}` : x.absolutePath, title: x.title || '' } : null;
}
export function editor() {
  const box = h(`<div class="cx-ed" id="cxEditor"><div class="cx-list"></div><div class="cx-foot"><button class="btn sm cx-add">${icon('plus')}${$t('Добавить колонку')}</button><span class="cx-hint"></span></div></div>`);
  const listEl = box.querySelector('.cx-list');
  let sample = null;
  const hint = box.querySelector('.cx-hint');
  sampleTrack().then((s) => { sample = s; hint.textContent = s ? $t('Пример — на треке «{0}»', s.title) : ''; preview(); });

  const preview = debounce(async () => {
    if (!sample) return;
    const items = [...listEl.querySelectorAll('.cx-item')];
    for (const it of items) {
      const tf = it.querySelector('.cx-tf').value.trim(), out = it.querySelector('.cx-pv');
      if (!tf) { out.textContent = ''; out.className = 'cx-pv'; continue; }
      const r = await call('titleformat.evalFieldsBatch', { paths: [sample.path], fields: { c0: pattern(tf) } });
      if (!ok(r)) { out.textContent = $t('Ошибка в шаблоне'); out.className = 'cx-pv bad'; continue; }
      const v = clean(r.results && r.results[0] && r.results[0].c0);
      out.textContent = v || $t('(пусто у этого трека)'); out.className = 'cx-pv' + (v ? '' : ' dim');
    }
  }, 220);

  const render = () => {
    const list = all();
    listEl.innerHTML = list.length ? '' : `<div class="cx-empty">${$t('Колонок пока нет. Добавьте готовую или напишите свой шаблон — например, %performer% или $if2(%label%,%publisher%).')}</div>`;
    list.forEach((c, i) => {
      const it = h(`<div class="cx-item" data-id="${c.id}">
        <div class="cx-move"><button class="icon-btn" data-a="up" title="${$t('Выше')}"${i ? '' : ' disabled'}>${icon('chev-up')}</button><button class="icon-btn" data-a="down" title="${$t('Ниже')}"${i < list.length - 1 ? '' : ' disabled'}>${icon('chev-up')}</button></div>
        <input class="st-input cx-name" maxlength="40" spellcheck="false" placeholder="${$t('Название')}" aria-label="${$t('Название колонки')}">
        <input class="st-input cx-tf" spellcheck="false" placeholder="%genre%" aria-label="${$t('Шаблон title formatting')}">
        <div class="seg cx-where"><button data-w="pl" title="${$t('Показывать в плейлистах')}">${$t('Плейлисты')}</button><button data-w="al" title="${$t('Показывать на странице альбома')}">${$t('Альбом')}</button></div>
        <button class="icon-btn" data-a="more" title="${$t('Ширина, выравнивание, удалить')}">${icon('more')}</button>
        <div class="cx-pv"></div>
      </div>`);
      const name = it.querySelector('.cx-name'), tf = it.querySelector('.cx-tf');
      name.value = c.name || ''; tf.value = c.tf;
      const commit = debounce(() => { const t = tf.value.trim(); if (t) update(c.id, { name: name.value.trim(), tf: t }); }, 450);
      name.oninput = commit;
      tf.oninput = () => { commit(); preview(); };
      tf.onblur = () => { if (!tf.value.trim()) { tf.value = c.tf; preview(); } };
      for (const b of it.querySelectorAll('[data-w]')) {
        b.classList.toggle('on', c[b.dataset.w] !== false);
        b.onclick = () => { const on = !b.classList.contains('on'); b.classList.toggle('on', on); update(c.id, { [b.dataset.w]: on }); };
      }
      it.querySelector('[data-a=up]').onclick = () => { move(c.id, -1); render(); };
      it.querySelector('[data-a=down]').onclick = () => { move(c.id, 1); render(); };
      it.querySelector('[data-a=more]').onclick = async (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        const cur = all().find((q) => q.id === c.id) || c;
        const id = await popupMenu([
          { id: 'w', label: $t('Ширина'), children: [['s', $t('Узкая')], ['m', $t('Обычная')], ['l', $t('Широкая')]].map(([v, l]) => ({ id: 'w:' + v, label: l, checked: (cur.w || 'm') === v })) },
          { id: 'a', label: $t('Выравнивание'), children: [['auto', $t('Авто')], ['left', $t('Слева')], ['center', $t('По центру')], ['right', $t('Справа')]].map(([v, l]) => ({ id: 'a:' + v, label: l, checked: (cur.align || 'auto') === v })) },
          { type: 'sep' },
          { id: 'del', label: $t('Удалить колонку') },
        ], r.left - 150, r.bottom + 4);
        if (!id) return;
        if (id === 'del') { remove(c.id); render(); return; }
        if (id.startsWith('w:')) update(c.id, { w: id.slice(2) });
        if (id.startsWith('a:')) update(c.id, { align: id.slice(2) });
      };
      listEl.append(it);
    });
    preview();
  };
  box.querySelector('.cx-add').onclick = async (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const used = new Set(all().map((c) => c.tf.trim()));
    const ps = PRESETS();
    const id = await popupMenu([
      ...ps.map((p, i) => ({ id: 'p:' + i, label: `${p.name}   ${p.tf.length > 26 ? p.tf.slice(0, 24) + '…' : p.tf}`, disabled: used.has(p.tf) })),
      { type: 'sep' }, { id: 'own', label: $t('Свой шаблон…') },
    ], r.left, r.bottom + 4);
    if (!id) return;
    const x = id === 'own' ? add({ name: '', tf: '%artist%' }) : add(ps[+id.slice(2)]);
    render();
    // your own: the pattern is selected, ready to be typed over
    if (id === 'own') { const tf = listEl.querySelector(`[data-id="${x.id}"] .cx-tf`); if (tf) { tf.focus(); tf.select(); } }
  };
  render();
  return box;
}
