/*
 * Gatefold · smartpl.js — smart playlists without the query language.
 *
 * foobar2000's autoplaylists are a library query kept live: new tracks that match appear by
 * themselves. Their syntax is powerful and nobody knows it, so Gatefold offers ready recipes
 * («recently added», «most played», «forgotten favourites», a genre, a decade, lossless, hi-res…),
 * each with one simple parameter, shows how many tracks match right now, and creates the
 * autoplaylist. «Your own query» is there for those who do know the syntax.
 * Play statistics (%added%, %play_count%, %last_played%, %rating%) come from foo_playcount.
 * «By sound» recipes use the neural sound analysis (ml/sound.js): moods and Discogs styles are not
 * tags foobar2000 can query, so those playlists are made once, from the analysis, not kept live.
 */
import { call, ok, esc, debounce, plural } from './bridge.js';
import { router, h, icon, toast } from './ui.js';
import { $t } from './i18n.js';
import * as Sound from './ml/sound.js';
import * as SoundUI from './ml/sound-ui.js';

const ALBUM_ORDER = '%album artist% | %date% | %album% | %discnumber% | %tracknumber%';
const q = (s) => '"' + String(s).replace(/"/g, '') + '"';
const DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];

/* every recipe: query(param) → { query, sort } — `sort` may be a SORT clause (tried first) */
const RECIPES = [
  { id: 'recent', g: 'listen', ic: 'inbox', stats: true, title: $t('Недавно добавленные'), desc: '' /* Новое в медиатеке, свежее сверху */,
    param: { kind: 'seg', label: $t('Период'), def: 30, opts: [[7, $t('7 дней')], [30, $t('30 дней')], [90, $t('3 месяца')]] },
    name: (n) => $t('Новое за {0} дн.', n), make: (n) => ({ query: `%added% DURING LAST ${n} DAYS`, sortDesc: '%added%' }) },
  { id: 'top', g: 'listen', ic: 'heart-f', stats: true, title: $t('Самое любимое'), desc: '' /* Чаще всего слушаете — по числу прослушиваний */,
    param: { kind: 'seg', label: $t('Сколько раз слушали'), def: 10, opts: [[5, $t('от 5 раз')], [10, $t('от 10')], [25, $t('от 25')]] },
    name: () => $t('Самое любимое'), make: (n) => ({ query: `%play_count% GREATER ${n - 1}`, sortDesc: '%play_count%' }) },
  { id: 'forgot', g: 'listen', ic: 'history', stats: true, title: $t('Забытые любимцы'), desc: '' /* Слушали много раз, но не включали полгода */,
    name: () => $t('Забытые любимцы'), make: () => ({ query: '%play_count% GREATER 4 AND NOT %last_played% DURING LAST 26 WEEKS', sort: '%last_played%' }) },
  { id: 'never', g: 'listen', ic: 'unheard', stats: true, title: $t('Ни разу не слушал'), desc: '' /* Всё, что лежит в медиатеке нетронутым */,
    name: () => $t('Ещё не слушал'), make: () => ({ query: 'NOT %play_count% GREATER 0', sort: ALBUM_ORDER }) },
  { id: 'rated', g: 'listen', ic: 'star', stats: true, title: $t('Высокая оценка'), desc: '' /* Оценка 4 и 5 звёзд */,
    name: () => $t('Высокая оценка'), make: () => ({ query: '%rating% GREATER 3', sortDesc: '%rating%' }) },
  { id: 'genre', g: 'tags', ic: 'tag', title: $t('Жанр'), desc: '' /* Один жанр из вашей медиатеки */,
    param: { kind: 'genre', label: $t('Жанр') }, name: (g) => g || $t('Жанр'), make: (g) => (g ? { query: `genre IS ${q(g)}`, sort: ALBUM_ORDER } : null) },
  { id: 'decade', g: 'tags', ic: 'calendar', title: $t('Десятилетие'), desc: '' /* Музыка одного десятилетия по дате релиза */,
    param: { kind: 'seg', label: $t('Десятилетие'), def: 1990, opts: DECADES.map((d) => [d, `${String(d).slice(2)}-е`]) },
    name: (d) => $t('{0}-е', d), make: (d) => ({ query: `%date% GREATER ${d - 1} AND %date% LESS ${d + 10}`, sort: '%date% | ' + ALBUM_ORDER }) },
  { id: 'lossless', g: 'tags', ic: 'wave', title: $t('Без потерь'), desc: '' /* FLAC, ALAC, WavPack, APE, WAV… */,
    name: () => $t('Без потерь'), make: () => ({ query: '%__encoding% IS lossless', sort: ALBUM_ORDER }) },
  { id: 'hires', g: 'tags', ic: 'hd', title: 'Hi-Res', desc: '' /* Выше 48 кГц или глубже 16 бит */,
    name: () => 'Hi-Res', make: () => ({ query: '%samplerate% GREATER 48000 OR %__bitspersample% GREATER 16', sort: ALBUM_ORDER }) },
  { id: 'long', g: 'tags', ic: 'hourglass', title: $t('Длинные треки'), desc: '' /* Дольше 10 минут: сюиты, миксы, эпики */,
    name: () => $t('Длинные треки'), make: () => ({ query: '%length_seconds% GREATER 599', sort: ALBUM_ORDER }) },
  { id: 'custom', g: 'tags', ic: 'code', title: $t('Свой запрос'), desc: '' /* Язык запросов foobar2000 — для тех, кто его знает */,
    param: { kind: 'text', label: $t('Запрос foobar2000') }, name: () => $t('Умный плейлист'), make: (s) => (s && s.trim() ? { query: s.trim() } : null) },
];
const MOOD_IC = { calm: 'moon', energy: 'bolt', sad: 'rain', happy: 'sun', party: 'party', instrumental: 'piano', acoustic: 'guitar' };
const SIZE = { kind: 'seg', label: $t('Треков в плейлисте'), def: 50, opts: [[25, '25'], [50, '50'], [100, '100']] };
const AI = [
  ...SoundUI.MOOD_RECIPES().map(([k, title, desc]) => ({ id: 'ai-' + k, g: 'ai', ai: true, ic: MOOD_IC[k] || 'sparkle', tone: k, title, desc, param: SIZE, name: () => title, make: (n) => ({ ai: k, n }) })),
  { id: 'ai-style', g: 'ai', ai: true, ic: 'radar', tone: 'style', title: $t('Жанр по звучанию'), desc: '' /* Жанры MusicBrainz и нейросети — и для треков без тегов */,
    param: { kind: 'style', label: $t('Жанр') }, name: (v) => v || $t('Жанр'), make: (v) => (v ? { ai: 'style', style: v, n: 100 } : null) },
];
RECIPES.push(...AI);
const GROUPS = [['listen', $t('По прослушиваниям')], ['tags', $t('По тегам')], ['ai', $t('По звучанию')]];

let veil = null, cur = null, val = null, genres = null;

const tracksWord = (n) => plural(n, 'трек', 'трека', 'треков');
/* the live answer: how many tracks match, and a few of them */
const countFor = debounce(async (r) => {
  const out = veil && veil.querySelector('.sp-count'), pv = veil && veil.querySelector('.sp-preview');
  if (!out) return;
  const spec = r.make(val);
  const show = (n, top, bad) => {
    out.classList.toggle('none', !n);
    out.innerHTML = n ? `<b>${n.toLocaleString()}</b><span>${$t('{0} подходит сейчас', tracksWord(n))}</span>` : `<span class="sp-bad">${bad || $t('Пока ничего не подходит')}</span>`;
    pv.innerHTML = (top || []).filter((t) => t.title).slice(0, 5).map((t) => `<li><span class="t">${esc(t.title)}</span><span class="a">${esc(t.artist)}</span></li>`).join('');
  };
  if (!spec) { out.classList.add('none'); out.innerHTML = ''; pv.innerHTML = ''; return; }
  if (spec.ai) { const m = SoundUI.matching(spec.ai, spec.style); show(m.n, m.top); return; }
  out.innerHTML = '<span class="spinner"></span>';
  const res = await call('library.query', { query: spec.query, limit: 6, fields: ['title', 'artist'], sort: spec.sort || '' });
  if (cur !== r) return;
  if (!ok(res)) { show(0, [], $t('foobar2000 не понял запрос')); return; }
  show(res.total || 0, res.tracks || [], r.stats ? $t('Нужен foo_playcount') : '');
}, 250);

function paramUI(r) {
  const box = h('<div class="sp-param"></div>');
  const p = r.param;
  if (!p) return box;
  if (p.label) box.append(h(`<label class="sp-label">${p.label}</label>`));
  if (p.kind === 'seg') {
    val = p.def;
    const seg = h('<div class="seg"></div>');
    for (const [v, t] of p.opts) {
      const b = h(`<button class="${v === val ? 'on' : ''}">${t}</button>`);
      b.onclick = () => { val = v; seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); syncName(); countFor(r); };
      seg.append(b);
    }
    box.append(seg);
  } else if (p.kind === 'genre') {
    val = '';
    const sel = h(`<select class="st-input sp-genre"><option value="">${$t('Загружаю жанры…')}</option></select>`);
    box.append(sel);
    (genres ? Promise.resolve(genres) : call('library.getGenres').then((g) => (genres = ok(g) ? g.genres || [] : []))).then((list) => {
      sel.innerHTML = list.length ? `<option value="">${$t('Выберите жанр')}</option>` + list.slice(0, 400).map((g) => `<option value="${esc(g.name)}">${esc(g.name)} · ${g.trackCount}</option>`).join('')
        : `<option value="">${$t('В тегах нет жанров')}</option>`;
    });
    sel.onchange = () => { val = sel.value; syncName(); countFor(r); };
  } else if (p.kind === 'style') {
    val = '';
    const st = SoundUI.libraryGenres();
    const sel = h(`<select class="st-input sp-style">${st.length ? `<option value="">${$t('Выберите жанр')}</option>` + st.slice(0, 150).map((x) => `<option value="${esc(x.name)}">${esc(x.name)} · ${x.n}</option>`).join('') : `<option value="">${$t('Пока нет проанализированных треков')}</option>`}</select>`);
    sel.onchange = () => { val = sel.value; syncName(); countFor(r); };
    box.append(sel);
  } else if (p.kind === 'text') {
    val = '';
    const ta = h(`<textarea class="st-input sp-query" rows="3" spellcheck="false" placeholder="genre HAS jazz AND %date% LESS 1970"></textarea>`);
    ta.addEventListener('keydown', (e) => e.stopPropagation());
    ta.oninput = () => { val = ta.value; countFor(r); };
    box.append(ta, h(`<a class="link sp-help" data-href="https://wiki.hydrogenaud.io/index.php?title=Foobar2000:Query_syntax">${$t('Справка по языку запросов')}</a>`));
  }
  return box;
}
let nameTouched = false;
function syncName() {
  const inp = veil && veil.querySelector('.sp-name');
  if (inp && !nameTouched && cur) inp.value = cur.name(val);
}

function pick(r) {
  cur = r; nameTouched = false;
  veil.querySelectorAll('.sp-card').forEach((c) => { c.classList.toggle('on', c.dataset.id === r.id); c.setAttribute('aria-selected', c.dataset.id === r.id); });
  const form = veil.querySelector('.sp-form');
  form.dataset.tone = r.tone || r.g;
  form.innerHTML = '';
  const hero = h(`<div class="sp-hero"><div class="sp-ic">${icon(r.ic, 26)}</div><div class="sp-hero-t"><div class="kicker">${GROUPS.find((x) => x[0] === r.g)[1]}</div><h4>${r.title}</h4></div></div>`);
  if (r.ai && !Sound.ready()) {
    form.append(hero, h(`<div class="sp-ai-off">${$t('Нужен анализ звука')} <button class="btn sm primary">${$t('Открыть настройки')}</button></div>`));
    form.querySelector('.sp-ai-off button').onclick = () => { close(); SoundUI.openSettings(); };
    return;
  }
  form.append(
    hero,
    h('<div class="sp-count none"></div>'),
    paramUI(r),
    h(`<div class="sp-pv"><div class="sp-label">${$t('Например')}</div><ol class="sp-preview"></ol></div>`),
    h(`<div class="sp-foot"><input class="st-input sp-name" spellcheck="false" placeholder="${$t('Название')}" aria-label="${$t('Название')}"><button class="btn primary sp-go">${icon('plus')}${$t('Создать')}</button></div>`),
  );
  const name = form.querySelector('.sp-name');
  name.value = r.name(val);
  name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') create(); });
  name.oninput = () => { nameTouched = true; };
  form.querySelector('.sp-go').onclick = create;
  countFor(r);
}

async function create() {
  const r = cur; if (!r) return;
  const spec = r.make(val);
  if (!spec) { toast(r.param && r.param.kind === 'genre' ? $t('Выберите жанр') : $t('Введите запрос')); return; }
  const name = (veil.querySelector('.sp-name').value || r.name(val)).trim();
  if (spec.ai) { close(); await SoundUI.moodPlaylist(spec.ai, name, spec.n, spec.style); return; }
  // a descending order goes into the query as a SORT clause; if this foobar2000 refuses it there,
  // the playlist is made with the plain query (ascending order) rather than not at all
  let res = await call('playlist.createAutoplaylist', spec.sortDesc
    ? { name, query: `${spec.query} SORT DESCENDING BY ${spec.sortDesc}` }
    : { name, query: spec.query, sort: spec.sort || '' });
  if (!ok(res) && spec.sortDesc) res = await call('playlist.createAutoplaylist', { name, query: spec.query, sort: spec.sortDesc });
  if (!ok(res)) { toast($t('foobar2000 не создал плейлист: {0}', esc(res.error || res.code || '?'))); return; }
  close();
  
  await call('playlist.setActive', { playlistGuid: res.guid });
  router.go('playlist', res.guid);
}

export function open(preset) {
  if (!veil) {
    const list = GROUPS.map(([g, title]) => `<div class="sp-group" role="group" aria-label="${esc(title)}"><div class="sp-gh">${title}</div>${RECIPES.filter((r) => r.g === g)
      .map((r) => `<button class="sp-card${r.ai ? ' ai' : ''}" data-id="${r.id}" data-tone="${r.tone || r.g}" role="option" title="${esc(r.title)}"><span class="sp-ic">${icon(r.ic, 16)}</span><b>${r.title}</b></button>`).join('')}</div>`).join('');
    veil = h(`<div class="upd-veil sp-veil"><div class="upd-sheet sp-sheet" role="dialog" aria-modal="true" aria-label="${$t('Умный плейлист')}">
      <header class="sp-top"><div class="kicker">${$t('Умный плейлист')}</div><button class="icon-btn sp-x" title="${$t('Закрыть')}">${icon('x', 16)}</button></header>
      <div class="sp-body"><nav class="sp-list" role="listbox">${list}</nav><section class="sp-form"></section></div></div></div>`);
    document.body.append(veil);
    veil.addEventListener('click', (e) => {
      if (e.target === veil || e.target.closest('.sp-x')) return close();
      const c = e.target.closest('.sp-card'); if (c) pick(RECIPES.find((r) => r.id === c.dataset.id));
      const a = e.target.closest('a[data-href]'); if (a) { e.preventDefault(); call('shell.openExternal', { url: a.dataset.href }); }
    });
    // ↑/↓ walk the recipes
    veil.querySelector('.sp-list').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault(); e.stopPropagation();
      const all = [...veil.querySelectorAll('.sp-card')]; const i = all.findIndex((c) => c.dataset.id === cur.id);
      const nx = all[Math.max(0, Math.min(all.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      pick(RECIPES.find((r) => r.id === nx.dataset.id)); nx.focus();
    });
    addEventListener('keydown', (e) => { if (veil && veil.classList.contains('on') && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
  }
  pick(RECIPES.find((r) => r.id === preset) || RECIPES[0]);
  requestAnimationFrame(() => { veil.classList.add('on'); const on = veil.querySelector('.sp-card.on'); on && on.scrollIntoView({ block: 'nearest' }); });
}
export function close() { veil && veil.classList.remove('on'); }
export const recipes = RECIPES;
