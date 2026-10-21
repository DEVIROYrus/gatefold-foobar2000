/*
 * Gatefold Covers — the cover finder of Gatefold as a panel for Default UI / Columns UI layouts
 * (a «WebView2 Panel» with this template, gatefold-covers). A separate add-on: it needs
 * foo_ui_webview2, not the Gatefold interface. gf/ holds Gatefold's own modules, copied unchanged
 * (the finder, the quality check, their settings), so it behaves exactly as in Gatefold.
 *
 *   · finds missing covers (iTunes · Deezer · MusicBrainz/Cover Art Archive) for the whole library
 *     and, as it plays, for the album that is playing;
 *   · checks the quality of the covers there are and replaces weak ones (with a backup, undoable);
 *   · uncertain matches wait for a click.
 */
import './gf/input-guard.js';
import { waitForBridge, call, on, ok, normTrack, esc, artUrl, plural } from './gf/bridge.js';
import { settings, setSetting } from './gf/settings.js';
import { h, toast } from './gf/ui.js';
import * as CF from './gf/coverfetch.js';
import * as Q from './gf/coverquality.js';
import { artDiag } from './gf/artbytes.js';
import { $t, lang } from './gf/i18n.js';

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- look: dark / light / like Windows */
const OWN = { Covers: 'Обложки', 'Looking for a cover:': 'Ищу обложку:', 'Theme': 'Тема', Auto: 'Авто', Dark: 'Тёмная', Light: 'Светлая' };
const tt = (s) => (lang === 'ru' && OWN[s]) || s;
const PKEY = 'gatefold.covers.v1';
const prefs = (() => { try { return { look: 'auto', ...(JSON.parse(localStorage.getItem(PKEY) || '{}') || {}) }; } catch { return { look: 'auto' }; } })();
const FIXED = {   // Gatefold's fixed themes (OKLCH)
  dark: { dark: true, bg: [0.172, 0.012, 266], surface: [0.207, 0.013, 266], text: [0.93, 0.008, 266], text2: [0.795, 0.012, 266], text3: [0.655, 0.014, 266], accent: [0.74, 0.12, 270], accent2: [0.76, 0.09, 205], onAccent: [0.18, 0.03, 270] },
  light: { dark: false, bg: [0.972, 0.005, 85], surface: [0.993, 0.003, 85], text: [0.235, 0.012, 266], text2: [0.42, 0.013, 266], text3: [0.53, 0.012, 266], accent: [0.53, 0.17, 268], accent2: [0.56, 0.11, 200], onAccent: [0.99, 0.004, 268] },
};
const ok_ = (L, C, h) => `oklch(${(L * 100).toFixed(1)}% ${C.toFixed(4)} ${h.toFixed(1)})`;
const mq = matchMedia('(prefers-color-scheme: dark)');
function applyLook() {
  const id = prefs.look === 'auto' ? (mq.matches ? 'dark' : 'light') : prefs.look;
  const f = FIXED[id], r = document.documentElement;
  const set = (k, v) => r.style.setProperty(k, ok_(...v));
  set('--bg', f.bg); set('--surface', f.surface); set('--surface-2', f.surface); set('--text', f.text); set('--text-2', f.text2); set('--text-3', f.text3);
  set('--accent', f.accent); set('--accent-ink', f.accent); set('--accent-2', f.accent2); set('--on-accent', f.onAccent);
  r.dataset.scheme = f.dark ? 'dark' : 'light'; r.style.colorScheme = f.dark ? 'dark' : 'light';
}
mq.addEventListener('change', applyLook);
applyLook();

/* ---------------------------------------------------------------- helpers (as in Gatefold's Covers screen) */
const card = (title, desc, wide) => h(`<div class="card${wide ? ' wide' : ''}"><h3>${title}</h3>${desc ? `<div class="desc">${desc}</div>` : ''}</div>`);
function toggle(key, label) {
  const el = h(`<div class="row"><div class="lbl"><b>${label}</b></div><label class="toggle"><input type="checkbox"><i></i></label></div>`);
  const inp = el.querySelector('input'); inp.checked = !!settings[key];
  inp.onchange = () => setSetting(key, inp.checked);
  return el;
}
function seg(key, label, opts) {
  const el = h(`<div class="row"><div class="lbl"><b>${label}</b></div><div class="seg"></div></div>`);
  const box = el.querySelector('.seg');
  for (const [v, l] of opts) {
    const b = h(`<button class="${String(settings[key]) === String(v) ? 'on' : ''}">${esc(l)}</button>`);
    b.onclick = () => { setSetting(key, v); render(); };
    box.append(b);
  }
  return el;
}
const btnRow = () => h('<div class="row" style="gap:8px;flex-wrap:wrap;border:0"></div>');
const addBtn = (row, txt, fn, cls = '') => { const e = h(`<button class="btn ${cls}">${txt}</button>`); e.onclick = fn; row.append(e); return e; };

/* cover thumbnails for a list of tracks, through foobar2000 (96 px) */
async function thumbs(paths) {
  const r = await call('artwork.getFb2kUrlByPathBatch', { paths, maxSize: Math.round(96 * Math.min(2, devicePixelRatio || 1)) });
  const m = new Map();
  if (ok(r)) for (const a of r.artworks || []) if (a.available !== false && a.dataUrl) m.set(a.path, artUrl(a.dataUrl));
  return (p) => m.get(p) || '';
}

/* keeps the nodes of cards whose markup did not change (images do not reload on every progress event) */
function morph(live, next) {
  const kids = [...next.children];
  kids.forEach((n, i) => {
    const sig = n.outerHTML, old = live.children[i];
    if (old && old.__sig === sig) return;
    n.__sig = sig;
    if (old) live.replaceChild(n, old); else live.appendChild(n);
  });
  while (live.children.length > kids.length) live.lastElementChild.remove();
}

/* ---------------------------------------------------------------- the screen */
let manual = null, qShow = 40, qOpen = '', playing = '';

function render() {
  const live = $('cpBody'), body = document.createElement('div');
  const st = CF.getStats(), s = CF.state;

  if (manual) {
    const c = card($t('Ручной поиск: {0}', esc(manual.job.album)), esc(manual.job.artist) + $t(' · все источники, отсортировано по совпадению'), true);
    if (manual.loading) c.append(h(`<div class="row"><div class="spinner"></div><div class="lbl">${$t('Опрашиваю iTunes, Deezer, MusicBrainz…')}</div></div>`));
    else if (!manual.cands.length) c.append(h(`<div class="empty"><b>${$t('Ничего не найдено')}</b></div>`));
    else { const grid = h('<div class="cands"></div>'); manual.cands.slice(0, 18).forEach((cd) => grid.appendChild(candEl(manual.job, cd))); c.append(grid); }
    const r = btnRow(); addBtn(r, $t('Закрыть'), () => { manual = null; render(); }); c.append(r);
    body.append(c);
  }

  // what the finder is doing
  const stc = card($t('Состояние'), s.busy ? `${$t('Сейчас:')} <b>${esc(s.busy.artist)} — ${esc(s.busy.album)}</b>` : (s.paused ? $t('Пауза') : (s.queue.length ? $t('В очереди…') : $t('Ожидание'))), true);
  stc.append(h(`<div class="stat-grid"><div class="stat"><b class="status-ok">${st.ok}</b><span>${$t('установлено')}</span></div><div class="stat"><b class="status-rev">${st.rev}</b><span>${$t('на проверке')}</span></div><div class="stat"><b>${st.nf}</b><span>${$t('не найдено')}</span></div><div class="stat"><b class="status-err">${st.err}</b><span>${$t('ошибки')}</span></div></div>`));
  if (s.total && (s.sweeping || s.sweepDone || s.scanned)) {
    const phase = s.sweeping ? $t('Проверка медиатеки') : s.sweepDone ? $t('Проверка завершена') : $t('Проверка остановлена');
    stc.append(h(`<div class="desc"><b>${phase}:</b> ${$t('{0} из {1} альбомов · с обложкой <b>{2}</b> · <b class="status-rev">без обложки {3}</b>', s.scanned, s.total, s.withArt, s.missing)}${s.skipped ? $t(' · пропущено (уже обработаны) {0}', s.skipped) : ''} ${$t('· в очереди поиска <b>{0}</b>', s.queue.length)}</div>`),
      h(`<div class="progress"><i style="width:${(s.scanned / s.total * 100).toFixed(1)}%"></i></div>`));
  } else stc.append(h(`<div class="desc">${$t('Проверка медиатеки ещё не запускалась в этой сессии.')}</div>`));
  const act = btnRow();
  addBtn(act, s.sweeping ? $t('Идёт проверка…') : $t('Проверить медиатеку'), () => { if (s.sweeping) return; CF.sweepLibrary(true); toast($t('Проверяю каждый альбом на наличие обложки')); }, 'primary');
  addBtn(act, s.paused ? $t('Продолжить') : $t('Приостановить'), () => CF.setPaused(!s.paused));
  addBtn(act, $t('Повторить «не найдено» и ошибки'), () => { CF.resetStatus('nf'); CF.resetStatus('err'); CF.sweepLibrary(true); });
  addBtn(act, $t('Сбросить историю'), () => { if (confirm($t('Сбросить все статусы обложек?'))) CF.resetStatus(); });
  stc.append(act);
  if (s.lastError) stc.append(h(`<div class="desc">${$t('Последняя ошибка:')} ${esc(s.lastError)}</div>`));
  body.append(stc);

  // uncertain matches
  const rev = CF.getReview();
  if (rev.length) {
    const rc = card($t('Требуют подтверждения · {0}', rev.length), '', true);
    for (const item of rev.slice(0, 12)) {
      const box = h(`<div style="padding:10px 0;border-top:1px solid var(--line)"><div style="display:flex;align-items:center;gap:10px"><div style="flex:1;min-width:0"><b>${esc(item.job.album)}</b> <span style="color:var(--text-3)">· ${esc(item.job.artist)}</span></div></div><div class="cands"></div></div>`);
      const r = box.firstChild;
      addBtn(r, $t('Искать ещё'), () => startManual(item.job), 'sm');
      addBtn(r, $t('Пропустить'), () => { CF.skipReview(item.key); render(); }, 'sm');
      item.cands.slice(0, 6).forEach((cd) => box.querySelector('.cands').appendChild(candEl(item.job, cd)));
      rc.append(box);
    }
    body.append(rc);
  }

  body.append(qualityCard());

  const sc = card($t('Параметры поиска'), '');
  sc.append(
    toggle('coverAuto', $t('Искать для играющего альбома')),
    toggle('coverSweep', $t('Фоновая проверка медиатеки')),
    seg('coverMinSize', $t('Минимальный размер'), [[500, '500'], [600, '600'], [800, '800'], [1000, '1000']]),
    seg('coverMaxSize', $t('Максимальный размер'), [[0, $t('Оригинал')], [3000, '3000'], [2000, '2000'], [1400, '1400']]),
    seg('coverThreshold', $t('Строгость совпадения'), [[0.78, $t('Мягко')], [0.82, $t('Норма')], [0.88, $t('Строго')]]),
    seg('coverTarget', $t('Куда сохранять'), [['file', 'cover.jpg'], ['all', $t('cover.jpg + теги')]]),
    seg('coverSharedDir', $t('Папка с несколькими альбомами'), [['embed', $t('Встраивать в треки')], ['skip', $t('Пропускать')]]),
  );
  const src = card($t('Источники'), '');
  const srcToggle = (k, label) => {
    const el = h(`<div class="row"><div class="lbl"><b>${label}</b></div><label class="toggle"><input type="checkbox"><i></i></label></div>`);
    const inp = el.querySelector('input'); inp.checked = !!settings.coverSources[k];
    inp.onchange = () => setSetting('coverSources', { ...settings.coverSources, [k]: inp.checked });
    return el;
  };
  const ctry = h(`<div class="row"><div class="lbl"><b>${$t('Витрины iTunes')}</b></div><input class="filter" style="width:120px" value="${esc(settings.coverCountries)}"></div>`);
  ctry.querySelector('input').onchange = (e) => setSetting('coverCountries', e.target.value.toUpperCase());
  src.append(srcToggle('itunes', 'iTunes / Apple Music'), srcToggle('deezer', 'Deezer'), srcToggle('musicbrainz', 'MusicBrainz + Cover Art Archive'), ctry);
  body.append(sc, src);

  const lg = card($t('Журнал'), '', true);
  const list = h('<div class="log"></div>');
  const label = { ok: $t('установлена'), nf: $t('не найдена'), err: $t('ошибка'), rev: $t('на проверке') };
  for (const e of CF.getLog().slice(0, 60)) {
    list.append(h(`<div class="log-row">${e.thumb ? `<img class="th" src="${esc(e.thumb)}" alt="" loading="lazy">` : '<div class="th"></div>'}<div style="min-width:0"><div class="t">${esc(e.album)} <span style="color:var(--text-3);font-weight:400">· ${esc(e.artist)}</span></div><div class="s"><span class="status-${e.s}">${label[e.s] || e.s}</span>${e.src ? ' · ' + esc(e.src) : ''}${e.w ? ` · ${e.w}×${e.h}` : ''}${e.sc ? $t(' · совпадение {0}%', Math.round(e.sc * 100)) : ''}${e.err ? ' · ' + esc(e.err) : ''}</div></div><div class="s num">${new Date(e.t).toLocaleTimeString().slice(0, 5)}</div></div>`));
  }
  if (!CF.getLog().length) list.append(h(`<div class="desc">${$t('Пока пусто')}</div>`));
  lg.append(list);
  body.append(lg);
  morph(live, body);
  $('cpCount').textContent = rev.length ? String(rev.length) : '';
}

function qualityCard() {
  if (!Q.qstate.loaded) Q.load();
  const qs = Q.qstate, sum = Q.summary();
  const c = card($t('Качество обложек'), '', true);
  if (qs.scanning) {
    c.append(h(`<div class="desc">${$t('<b>Проверка:</b> {0} из {1} альбомов · с обложкой {2} · найдено слабых {3}', qs.scanned, qs.total || '…', qs.withArt, Q.rows.filter((r) => r.flags.length).length)}</div>`),
      h(`<div class="progress"><i style="width:${qs.total ? (qs.scanned / qs.total * 100).toFixed(1) : 2}%"></i></div>`));
  } else if (qs.scannedAt) {
    c.append(h(`<div class="stat-grid"><div class="stat"><b>${qs.withArt}</b><span>${$t('проверено обложек')}</span></div><div class="stat"><b class="status-rev">${sum.lowres}</b><span>${$t('низкое разрешение')}</span></div><div class="stat"><b class="status-rev">${sum.jpegq}</b><span>${$t('сильно сжаты')}</span></div><div class="stat"><b>${sum.aspect}</b><span>${$t('не квадратные')}</span></div><div class="stat"><b class="status-ok">${sum.upgraded}</b><span>${$t('улучшено')}</span></div></div>`));
    c.append(h(`<div class="desc">${$t('Последняя проверка:')} ${new Date(qs.scannedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}${sum.review ? ` · <b class="status-rev">${$t('ждут решения:')} ${sum.review}</b>` : ''}${sum.todo ? $t(' · не обработано: {0}', sum.todo) : ''}</div>`));
  } else c.append(h(`<div class="desc">${$t('Ещё не проверялось')}</div>`));
  const act = btnRow();
  addBtn(act, qs.scanning ? $t('Идёт проверка…') : qs.scannedAt ? $t('Проверить заново') : $t('Проверить качество'), () => { if (!qs.scanning) Q.scan(); }, qs.scannedAt ? '' : 'primary');
  if (qs.scannedAt && sum.todo) addBtn(act, qs.auto ? $t('Остановить') : $t('Улучшить автоматически ({0})', sum.todo), () => (qs.auto ? Q.stopAll() : Q.upgradeAll()), qs.auto ? '' : 'primary');
  if (qs.scanning || qs.auto) addBtn(act, qs.paused ? $t('Продолжить') : $t('Приостановить'), () => Q.setPaused(!qs.paused));
  c.append(act,
    seg('qualityMinRes', $t('Низкое разрешение — меньше'), [[500, '500'], [600, '600'], [800, '800'], [1000, '1000']]),
    seg('qualityAuto', $t('Автозамена'), [['same', $t('Если совпадает')], ['never', $t('Всегда спрашивать')]]));
  if (artDiag.mode) c.append(h(`<div class="desc">${$t('Чтение обложек:')} ${{ fb2k: $t('напрямую (fb2k://)'), same: $t('напрямую (локальный адрес)'), bridge: $t('через foobar — медленнее, но работает всегда'), plain: $t('напрямую') }[artDiag.mode] || artDiag.mode}</div>`));
  if (qs.lastError) c.append(h(`<div class="desc">${$t('Последняя ошибка:')} ${esc(qs.lastError)}</div>`));

  const list = Q.rows.filter((r) => r.flags.length || r.st === 'upgraded');
  if (list.length) {
    const box = h('<div class="qlist"></div>');
    const label = { flag: '', busy: $t('ищу замену…'), review: $t('нужно решение'), nobetter: $t('лучше не найдено'), err: $t('ошибка'), kept: $t('оставлена'), upgraded: $t('улучшена'), ok: $t('в порядке') };
    const shown = list.slice(0, qShow);
    for (const r of shown) {
      const el = h(`<div class="qrow st-${r.st}"><div class="th"><img alt=""></div><div class="qi"><div class="t">${esc(r.album)} <span>· ${esc(r.artist)}</span></div><div class="s">${Q.flagText(r).map((x) => `<span class="chip">${esc(x)}</span>`).join('')}${r.fmt && !r.flags.includes('jpegq') && r.fmt !== 'JPEG' ? `<span class="chip">${r.fmt}</span>` : ''}<span class="qst">${r.st === 'busy' ? '<span class="spinner"></span>' : ''}${esc(label[r.st] || '')}${r.note ? ' · ' + esc(r.note) : ''}</span></div></div><div class="qa"></div></div>`);
      const qa = el.querySelector('.qa');
      const qb = (txt, fn, cls = 'btn sm') => { const e = h(`<button class="${cls}">${txt}</button>`); e.onclick = async (ev) => { ev.stopPropagation(); e.disabled = true; try { await fn(); } catch (err) { toast(esc(err.message)); } e.disabled = false; }; qa.append(e); };
      if (r.st === 'flag' || r.st === 'err' || r.st === 'nobetter' || r.st === 'kept') qb($t('Найти лучше'), () => Q.upgrade(Q.rows.find((x) => x.key === r.key) || r));
      if (r.st === 'review') qb(qOpen === r.key ? $t('Скрыть') : $t('Выбрать'), () => { qOpen = qOpen === r.key ? '' : r.key; render(); }, 'btn sm primary');
      if (r.st === 'upgraded' && r.jid) qb($t('Вернуть прежнюю'), async () => { await Q.undo(r.jid); toast($t('Прежняя обложка возвращена')); });
      box.append(el);
      if (r.st === 'review' && qOpen === r.key && r.cands) {
        const grid = h('<div class="cands qcands"></div>');
        for (const cd of r.cands) {
          const v = { same: [$t('совпадает с текущей'), 'ok'], similar: [$t('похожа'), 'rev'], different: [$t('другая картинка'), 'err'] }[cd.verdict] || ['', ''];
          const ce = h(`<div class="cand"><img src="${esc(Q.previewFor(r.key, cd))}" alt="" loading="lazy"><div class="ct">${cd.w}×${cd.h} · ${esc(cd.src)}</div><div class="cs"><span class="status-${v[1]}">${v[0]}</span> ${$t('· альбом')} ${Math.round(cd.score * 100)}%</div><div class="cs">${esc(cd.title || '')}</div></div>`);
          ce.onclick = async () => { ce.style.opacity = '.5'; ce.style.pointerEvents = 'none'; await Q.applyCandidate(r.key, cd); qOpen = ''; };
          grid.append(ce);
        }
        const keep = btnRow(); addBtn(keep, $t('Оставить текущую'), () => { Q.keep(r.key); qOpen = ''; }, 'sm');
        box.append(grid, keep);
      }
    }
    if (list.length > qShow) { const more = h(`<button class="btn sm" style="margin-top:8px">${$t('Показать ещё ({0})', list.length - qShow)}</button>`); more.onclick = () => { qShow += 60; render(); }; box.append(more); }
    c.append(box);
    thumbs(shown.map((r) => r.path)).then((get) => {
      box.querySelectorAll('.qrow').forEach((el, i) => { const u = get(shown[i].path); const im = el.querySelector('img'); if (u) { im.onload = () => im.classList.add('on'); im.src = u; } });
    });
  }
  const jr = Q.getJournal().slice(0, 12);
  if (jr.length) {
    const jl = h('<div class="log" style="max-height:220px;margin-top:10px"></div>');
    jl.append(h(`<div class="desc" style="margin:0 0 4px"><b>${$t('История замен')}</b> ${$t('· резервные копии: {0}', '%profile%\\aurora\\backup\\covers')}</div>`));
    for (const e of jr) {
      const row = h(`<div class="log-row" style="grid-template-columns:1fr auto auto"><div style="min-width:0"><div class="t">${esc(e.album)} <span style="color:var(--text-3);font-weight:400">· ${esc(e.artist)}</span></div><div class="s">${esc(e.from)} → ${esc(e.to)} · ${esc(e.src || '')} · ${e.mode === 'embed' ? $t('встроена в {0} тр.', (e.tracks || []).length) : e.mode === 'add-file' ? $t('cover.jpg добавлен') : $t('файл заменён')}${e.undone ? ` · <b>${$t('возвращено')}</b>` : ''}</div></div><div class="s num">${new Date(e.t).toLocaleDateString()}</div><div></div></div>`);
      if (!e.undone) { const ub = h(`<button class="btn sm">${$t('Вернуть')}</button>`); ub.onclick = async () => { ub.disabled = true; try { await Q.undo(e.id); toast($t('Возвращено')); } catch (err) { toast(esc(err.message)); ub.disabled = false; } }; row.lastChild.append(ub); }
      jl.append(row);
    }
    c.append(jl);
  }
  return c;
}

function candEl(job, cd) {
  const el = h(`<div class="cand"><img src="${esc(cd.thumb)}" alt="" loading="lazy"><div class="ct">${esc(cd.title)}</div><div class="cs">${esc(cd.artist || '')}${cd.year ? ' · ' + cd.year : ''}</div><div class="cs">${esc(cd.src)} · ${$t('до {0}px', cd.res)} · ${Math.round((cd.score || 0) * 100)}%</div></div>`);
  el.onclick = async () => {
    el.style.opacity = '.5'; el.style.pointerEvents = 'none';
    try { await CF.applyCandidate(job, cd); if (manual && manual.job.key === job.key) manual = null; render(); }
    catch (e) { toast($t('Не подошла: ') + esc(e.message)); el.style.opacity = ''; el.style.pointerEvents = ''; }
  };
  return el;
}
async function startManual(job) {
  if (!job) return;
  manual = { job, cands: [], loading: true }; render();
  const cands = await CF.findCandidates(job, { exhaustive: true });
  if (!manual || manual.job.key !== job.key) return;
  manual.cands = cands; manual.loading = false; render();
}

/* re-rendered on the engines' progress, at most every 800 ms, never while hidden */
let rT = 0, rLast = 0, rPending = false;
function schedule() {
  if (rT) return;
  if (document.visibilityState === 'hidden') { rPending = true; return; }
  rT = setTimeout(() => { rT = 0; rLast = performance.now(); const sc = $('cpScroll'), y = sc.scrollTop; render(); sc.scrollTop = y; }, Math.max(120, 800 - (performance.now() - rLast)));
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && rPending) { rPending = false; schedule(); } });
CF.events.addEventListener('change', schedule);
CF.events.addEventListener('repaired', schedule);
Q.events.addEventListener('change', schedule);

/* ---------------------------------------------------------------- the playing album */
async function watchTrack(t) {
  if (!t || !t.path || /^https?:/i.test(t.path)) { $('cpNow').textContent = ''; return; }
  playing = t.handle || t.path;
  const r = await call('artwork.getFb2kUrl', { type: 'front', maxSize: 128 });
  let has = ok(r) && r.available !== false && !!r.dataUrl;
  if (has) has = await new Promise((res) => { const im = new Image(); im.onload = () => res(im.naturalWidth > 1); im.onerror = () => res(false); im.src = artUrl(r.dataUrl); });
  if (playing !== (t.handle || t.path)) return;
  if (!has && settings.coverAuto) {
    const job = CF.jobFromTrack(t);
    if (job && CF.enqueue(job, true)) $('cpNow').textContent = `${tt('Looking for a cover:')} ${t.album || t.title}`;
  } else $('cpNow').textContent = '';
}

function header() {
  $('cpTitle').textContent = tt('Covers');
  const sel = $('cpLook');
  sel.title = tt('Theme');
  sel.innerHTML = ['auto', 'dark', 'light'].map((v) => `<option value="${v}"${prefs.look === v ? ' selected' : ''}>${tt({ auto: 'Auto', dark: 'Dark', light: 'Light' }[v])}</option>`).join('');
  sel.onchange = () => { prefs.look = sel.value; try { localStorage.setItem(PKEY, JSON.stringify(prefs)); } catch {} applyLook(); };
}

(async function boot() {
  header();
  render();
  if (!(await waitForBridge())) { toast($t('Нет связи с foobar2000'), { ms: 10000 }); return; }
  on('playback:trackChanged', (d) => watchTrack(normTrack(d)));
  const cur = await call('playback.getCurrentTrack');
  if (ok(cur) && cur.found !== false) watchTrack(normTrack(cur.track || cur.playing || cur));
  CF.events.addEventListener('change', () => { if (!CF.state.busy && !CF.state.queue.length) $('cpNow').textContent = ''; });
  if (settings.coverSweep) setTimeout(() => { if (!CF.state.sweeping) CF.sweepLibrary(); }, 8000);
  render();
})();

export { plural };
