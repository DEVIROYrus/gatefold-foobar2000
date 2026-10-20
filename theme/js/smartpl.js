/*
 * Gatefold · smartpl.js — smart playlists without the query language.
 *
 * foobar2000's autoplaylists are a library query kept live: new tracks that match appear by
 * themselves. Their syntax is powerful and nobody knows it, so Gatefold offers ready recipes
 * («recently added», «most played», «forgotten favourites», a genre, a decade, lossless, hi-res…),
 * each with one simple parameter, shows how many tracks match right now, and creates the
 * autoplaylist. «Your own query» is there for those who do know the syntax.
 * Play statistics (%added%, %play_count%, %last_played%, %rating%) come from foo_playcount.
 */
import { call, ok, esc, debounce, plural } from './bridge.js';
import { router, h, icon, toast } from './ui.js';
import { $t } from './i18n.js';

const ALBUM_ORDER = '%album artist% | %date% | %album% | %discnumber% | %tracknumber%';
const q = (s) => '"' + String(s).replace(/"/g, '') + '"';
const DECADES = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020];

/* every recipe: query(param) → { query, sort } — `sort` may be a SORT clause (tried first) */
const RECIPES = [
  { id: 'recent', ic: 'sparkle', stats: true, title: $t('Недавно добавленные'), desc: $t('Новое в медиатеке, свежее сверху'),
    param: { kind: 'seg', def: 30, opts: [[7, $t('7 дней')], [30, $t('30 дней')], [90, $t('3 месяца')]] },
    name: (n) => $t('Новое за {0} дн.', n), make: (n) => ({ query: `%added% DURING LAST ${n} DAYS`, sortDesc: '%added%' }) },
  { id: 'top', ic: 'heart-f', stats: true, title: $t('Самое любимое'), desc: $t('Чаще всего слушаете — по числу прослушиваний'),
    param: { kind: 'seg', def: 10, opts: [[5, $t('от 5 раз')], [10, $t('от 10')], [25, $t('от 25')]] },
    name: () => $t('Самое любимое'), make: (n) => ({ query: `%play_count% GREATER ${n - 1}`, sortDesc: '%play_count%' }) },
  { id: 'forgot', ic: 'history', stats: true, title: $t('Забытые любимцы'), desc: $t('Слушали много раз, но не включали полгода'),
    name: () => $t('Забытые любимцы'), make: () => ({ query: '%play_count% GREATER 4 AND NOT %last_played% DURING LAST 26 WEEKS', sort: '%last_played%' }) },
  { id: 'never', ic: 'disc', stats: true, title: $t('Ни разу не слушал'), desc: $t('Всё, что лежит в медиатеке нетронутым'),
    name: () => $t('Ещё не слушал'), make: () => ({ query: 'NOT %play_count% GREATER 0', sort: ALBUM_ORDER }) },
  { id: 'rated', ic: 'sparkle', stats: true, title: $t('Высокая оценка'), desc: $t('Оценка 4 и 5 звёзд'),
    name: () => $t('Высокая оценка'), make: () => ({ query: '%rating% GREATER 3', sortDesc: '%rating%' }) },
  { id: 'genre', ic: 'music', title: $t('Жанр'), desc: $t('Один жанр из вашей медиатеки'),
    param: { kind: 'genre' }, name: (g) => g || $t('Жанр'), make: (g) => (g ? { query: `genre IS ${q(g)}`, sort: ALBUM_ORDER } : null) },
  { id: 'decade', ic: 'history', title: $t('Десятилетие'), desc: $t('Музыка одного десятилетия по дате релиза'),
    param: { kind: 'seg', def: 1990, opts: DECADES.map((d) => [d, `${String(d).slice(2)}-е`]) },
    name: (d) => $t('{0}-е', d), make: (d) => ({ query: `%date% GREATER ${d - 1} AND %date% LESS ${d + 10}`, sort: '%date% | ' + ALBUM_ORDER }) },
  { id: 'lossless', ic: 'hd', title: $t('Без потерь'), desc: $t('FLAC, ALAC, WavPack, APE, WAV…'),
    name: () => $t('Без потерь'), make: () => ({ query: '%__encoding% IS lossless', sort: ALBUM_ORDER }) },
  { id: 'hires', ic: 'hd', title: 'Hi-Res', desc: $t('Выше 48 кГц или глубже 16 бит'),
    name: () => 'Hi-Res', make: () => ({ query: '%samplerate% GREATER 48000 OR %__bitspersample% GREATER 16', sort: ALBUM_ORDER }) },
  { id: 'long', ic: 'queue', title: $t('Длинные треки'), desc: $t('Дольше 10 минут: сюиты, миксы, эпики'),
    name: () => $t('Длинные треки'), make: () => ({ query: '%length_seconds% GREATER 599', sort: ALBUM_ORDER }) },
  { id: 'custom', ic: 'search', title: $t('Свой запрос'), desc: $t('Язык запросов foobar2000 — для тех, кто его знает'),
    param: { kind: 'text' }, name: () => $t('Умный плейлист'), make: (s) => (s && s.trim() ? { query: s.trim() } : null) },
];

let veil = null, cur = null, val = null, genres = null;

const countFor = debounce(async (r) => {
  const out = veil && veil.querySelector('.sp-count');
  if (!out) return;
  const spec = r.make(val);
  if (!spec) { out.textContent = ''; return; }
  out.innerHTML = `<span class="spinner"></span>`;
  const res = await call('library.query', { query: spec.query, limit: 0, fields: ['title'] });
  if (cur !== r) return;
  if (!ok(res)) { out.innerHTML = `<span class="sp-bad">${$t('foobar2000 не понял запрос')}</span>`; return; }
  const n = res.total || 0;
  out.innerHTML = n ? `<span>${$t('Сейчас подходит: <b>{0}</b> {1}', n.toLocaleString(), plural(n, 'трек', 'трека', 'треков'))}</span>`
    : `<span class="sp-bad">${r.stats ? $t('Пока ничего — нужен компонент Playback Statistics (foo_playcount) и немного времени') : $t('Пока ничего не подходит')}</span>`;
}, 250);

function paramUI(r) {
  const box = h('<div class="sp-param"></div>');
  const p = r.param;
  if (!p) return box;
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
  veil.querySelectorAll('.sp-card').forEach((c) => c.classList.toggle('on', c.dataset.id === r.id));
  const form = veil.querySelector('.sp-form');
  form.innerHTML = '';
  form.append(
    h(`<div class="sp-form-h"><b>${r.title}</b><small>${r.desc}</small></div>`),
    paramUI(r),
    h(`<div class="sp-row"><input class="st-input sp-name" spellcheck="false" placeholder="${$t('Название')}"><button class="btn primary sp-go">${icon('plus')}${$t('Создать')}</button></div>`),
    h('<div class="sp-count"></div>'),
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
  // a descending order goes into the query as a SORT clause; if this foobar2000 refuses it there,
  // the playlist is made with the plain query (ascending order) rather than not at all
  let res = await call('playlist.createAutoplaylist', spec.sortDesc
    ? { name, query: `${spec.query} SORT DESCENDING BY ${spec.sortDesc}` }
    : { name, query: spec.query, sort: spec.sort || '' });
  if (!ok(res) && spec.sortDesc) res = await call('playlist.createAutoplaylist', { name, query: spec.query, sort: spec.sortDesc });
  if (!ok(res)) { toast($t('foobar2000 не создал плейлист: {0}', esc(res.error || res.code || '?'))); return; }
  close();
  toast($t('Умный плейлист «{0}» создан — он сам пополняется новыми треками', esc(name)), { ms: 6000 });
  await call('playlist.setActive', { playlistGuid: res.guid });
  router.go('playlist', res.guid);
}

export function open(preset) {
  if (!veil) {
    veil = h(`<div class="upd-veil sp-veil"><div class="upd-sheet sp-sheet" role="dialog" aria-modal="true">
      <button class="icon-btn upd-x" title="${$t('Закрыть')}">${icon('x', 16)}</button>
      <div class="sp-head"><div class="upd-badge">${icon('sparkle', 22)}</div><div><div class="kicker">${$t('Умный плейлист')}</div><h3>${$t('Выберите рецепт')}</h3>
        <div class="sub">${$t('Плейлист сам пополняется: новые подходящие треки появятся в нём без вашего участия')}</div></div></div>
      <div class="sp-grid">${RECIPES.map((r) => `<button class="sp-card" data-id="${r.id}">${icon(r.ic, 18)}<b>${r.title}</b><small>${r.desc}</small></button>`).join('')}</div>
      <div class="sp-form"></div></div></div>`);
    document.body.append(veil);
    veil.addEventListener('click', (e) => {
      if (e.target === veil || e.target.closest('.upd-x')) return close();
      const c = e.target.closest('.sp-card'); if (c) pick(RECIPES.find((r) => r.id === c.dataset.id));
      const a = e.target.closest('a[data-href]'); if (a) { e.preventDefault(); call('shell.openExternal', { url: a.dataset.href }); }
    });
    addEventListener('keydown', (e) => { if (veil && veil.classList.contains('on') && e.key === 'Escape') { e.stopPropagation(); close(); } }, true);
  }
  pick(RECIPES.find((r) => r.id === preset) || RECIPES[0]);
  requestAnimationFrame(() => veil.classList.add('on'));
}
export function close() { veil && veil.classList.remove('on'); }
export const recipes = RECIPES;
