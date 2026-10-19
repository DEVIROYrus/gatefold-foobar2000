/*
 * Gatefold · fb2kprefs.js — Settings → foobar2000: the player's own settings people change most,
 * drawn in the theme instead of foobar2000's native Preferences dialog.
 *
 * Everything here reads and writes foobar2000's real configuration through the bridge (config.*,
 * replaygain.*, library.*), so a change made here shows up in the native dialog and the other way
 * round. What the bridge cannot change — library folders, keyboard shortcuts, third-party component
 * pages, file associations — gets a button that opens the native page instead.
 *
 * Every group fills itself after the settings screen is drawn; a call the installed component does
 * not know leaves a short note instead of the controls.
 */
import { call, ok, esc, debounce } from './bridge.js';
import { h, icon, toast, popupMenu } from './ui.js';
import { $t } from './i18n.js';

const row = (label, hint, ctl = '') => h(`<div class="row"><div class="lbl"><b>${label}</b>${hint ? `<small>${hint}</small>` : ''}</div>${ctl}</div>`);
const note = (text) => h(`<div class="row st-note"><div class="lbl"><small>${text}</small></div></div>`);
const unavailable = () => note($t('Недоступно в установленной версии компонента WebView2 UI.'));
const fail = (r) => toast($t('foobar2000 не принял изменение: {0}', esc((r && (r.error || r.code)) || '?')));
const nativePrefs = () => call('misc.showPreferences');

/** a segmented control whose value lives in foobar2000 */
function segCtl(options, current, onPick) {
  const box = h('<div class="seg"></div>');
  for (const [val, text] of options) {
    const b = h(`<button>${text}</button>`);
    b.classList.toggle('on', String(val) === String(current));
    b.onclick = async () => {
      if (b.classList.contains('on')) return;
      const prev = box.querySelector('.on');
      box.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on');
      if (!(await onPick(val))) { b.classList.remove('on'); prev && prev.classList.add('on'); }
    };
    box.append(b);
  }
  return box;
}
/** a slider row whose value lives in foobar2000; writes are debounced while dragging */
function sliderRow(label, hint, { min, max, step, value, fmt, commit }) {
  const el = row(`${label} <span class="num" style="color:var(--text-3);font-weight:500"></span>`, hint, `<input class="range" type="range" min="${min}" max="${max}" step="${step}">`);
  const inp = el.querySelector('input'), out = el.querySelector('.num');
  const paint = () => { inp.style.setProperty('--p', ((inp.value - min) / (max - min) * 100) + '%'); out.textContent = fmt(+inp.value); };
  inp.value = value; paint();
  const send = debounce(() => commit(+inp.value), 250);
  inp.oninput = () => { paint(); send(); };
  return el;
}
const db = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1).replace('.0', '') + ' dB';

/* ---------------------------------------------------------------- output */
async function fillOutput(g) {
  const [dv, cf] = await Promise.all([call('config.getOutputDevices'), call('config.getOutputConfig')]);
  if (!ok(dv) || !ok(cf)) { g.append(unavailable()); return; }
  const devs = dv.devices || [];
  const cur = devs.find((d) => d.isCurrent) || null;
  const name = cur ? cur.name : [cf.outputName, cf.deviceName].filter(Boolean).join(' · ') || $t('Не выбрано');
  const dev = row($t('Устройство'), $t('Куда foobar2000 выводит звук. WASAPI exclusive отдаёт поток в обход микшера Windows'),
    `<button class="btn sm st-pick"><span class="st-pick-t">${esc(name)}</span>${icon('chev', 14)}</button>`);
  const btn = dev.querySelector('.st-pick');
  btn.onclick = async () => {
    const r = btn.getBoundingClientRect();
    const items = []; let lastOut = null;
    devs.forEach((d, i) => {
      if (lastOut !== null && d.outputId !== lastOut) items.push({ type: 'sep' });
      lastOut = d.outputId;
      items.push({ id: String(i), label: d.name, checked: d.isCurrent });
    });
    const id = await popupMenu(items, r.left, r.bottom + 4);
    if (id == null) return;
    const d = devs[+id];
    const res = await call('config.setOutputDevice', { outputId: d.outputId, deviceId: d.deviceId });
    if (!ok(res)) return fail(res);
    devs.forEach((x) => (x.isCurrent = x === d));
    btn.querySelector('.st-pick-t').textContent = d.name;
    toast($t('Вывод: {0}', esc(d.name)));
  };
  const ms = Math.round((cf.bufferLength || 1) * 1000);
  g.append(dev,
    sliderRow($t('Буфер вывода'), $t('Больше — устойчивее к нагрузке на компьютер, меньше — быстрее отклик на перемотку и громкость'),
      { min: 50, max: 2000, step: 10, value: ms, fmt: (v) => v + ' ' + $t('мс'),
        commit: async (v) => { const r = await call('config.setOutputBuffer', { milliseconds: v }); if (!ok(r)) fail(r); } }));
  if (cf.bitDepth) g.append(note($t('Разрядность {0} бит · дизеринг {1} · плавные переходы {2} — меняются в родном окне (Playback → Output).', cf.bitDepth, cf.useDither ? $t('вкл.') : $t('выкл.'), cf.useFades ? $t('вкл.') : $t('выкл.'))));
}

/* ---------------------------------------------------------------- ReplayGain */
async function fillReplayGain(g) {
  const st = await call('replaygain.getSettings');
  if (!ok(st)) { g.append(unavailable()); return; }
  const setMode = async (p) => { const r = await call('replaygain.setMode', p); if (!ok(r)) { fail(r); return false; } return true; };
  const setPre = async (p) => { const r = await call('replaygain.setPreamp', p); if (!ok(r)) fail(r); };
  g.append(
    row($t('Источник'), $t('Выравнивает громкость по меткам ReplayGain в файлах. «По порядку»: трек при случайном порядке, альбом при обычном'),
      '').appendChild(segCtl([['none', $t('Выкл.')], ['track', $t('Трек')], ['album', $t('Альбом')], ['auto', $t('По порядку')]], st.sourceMode, (v) => setMode({ sourceMode: v }))).parentElement,
    row($t('Обработка'), $t('«Пики» не дают громким трекам перегружаться после усиления'), '')
      .appendChild(segCtl([['gain', $t('Усиление')], ['gain_and_peak', $t('Усиление и пики')], ['peak', $t('Только пики')], ['none', $t('Ничего')]], st.processingMode, (v) => setMode({ processingMode: v }))).parentElement,
    sliderRow($t('Предусиление с ReplayGain'), $t('Для треков с метками'), { min: -24, max: 24, step: 0.5, value: st.preampWithRg, fmt: db, commit: (v) => setPre({ withRg: v }) }),
    sliderRow($t('Предусиление без ReplayGain'), $t('Для треков без меток; обычно ниже, чтобы они не были громче остальных'), { min: -24, max: 24, step: 0.5, value: st.preampWithoutRg, fmt: db, commit: (v) => setPre({ withoutRg: v }) }),
  );
}

/* ---------------------------------------------------------------- DSP */
async function fillDsp(g) {
  const [ps, act] = await Promise.all([call('config.getDspPresets'), call('config.getActiveDspPreset')]);
  if (!ok(ps)) { g.append(unavailable()); return; }
  const list = ps.presets || [];
  if (!list.length) {
    g.append(note($t('Пресетов DSP пока нет. Их создают в родном окне: Playback → DSP Manager → Save preset.')));
    return;
  }
  const cur = ok(act) && act.isActive ? act.name : null;
  const r = row($t('Пресет DSP'), $t('Заменяет всю цепочку DSP цепочкой из пресета'), `<button class="btn sm st-pick"><span class="st-pick-t">${esc(cur || $t('Не выбран'))}</span>${icon('chev', 14)}</button>`);
  const btn = r.querySelector('.st-pick');
  btn.onclick = async () => {
    const b = btn.getBoundingClientRect();
    const id = await popupMenu(list.map((p) => ({ id: String(p.index), label: p.name, checked: p.name === btn.textContent.trim() })), b.left, b.bottom + 4);
    if (id == null) return;
    const res = await call('config.setActiveDspPreset', { index: +id });
    if (!ok(res)) return fail(res);
    const p = list.find((x) => String(x.index) === id);
    btn.querySelector('.st-pick-t').textContent = p ? p.name : id;
  };
  g.append(r);
}

/* ---------------------------------------------------------------- behaviour */
async function fillBehaviour(g) {
  const [pf, cf] = await Promise.all([call('config.getPlaybackFollowCursor'), call('config.getCursorFollowPlayback')]);
  if (!ok(pf) || !ok(cf)) { g.append(unavailable()); return; }
  const tog = (label, hint, value, method) => {
    const el = row(label, hint, '<label class="toggle"><input type="checkbox"><i></i></label>');
    const inp = el.querySelector('input'); inp.checked = !!value;
    inp.onchange = async () => { const r = await call(method, { enabled: inp.checked }); if (!ok(r)) { inp.checked = !inp.checked; fail(r); } };
    return el;
  };
  g.append(
    tog($t('Воспроизведение следует за курсором'), $t('После текущего трека играет тот, что выделен в плейлисте, а не следующий'), pf.enabled, 'config.setPlaybackFollowCursor'),
    tog($t('Курсор следует за воспроизведением'), $t('Выделение в плейлисте foobar2000 переходит на играющий трек'), cf.enabled, 'config.setCursorFollowPlayback'),
  );
}

/* ---------------------------------------------------------------- media library */
async function fillLibrary(g) {
  const [st, roots] = await Promise.all([call('config.getLibraryStatus'), call('library.getRoots')]);
  const open = () => call('config.showLibraryPreferences');
  const head = row($t('Папки медиатеки'),
    ok(st) ? (st.enabled ? $t('Треков в медиатеке: {0}', (st.itemCount || 0).toLocaleString()) : $t('Медиатека не настроена — добавьте папку с музыкой')) : '',
    `<button class="btn sm">${icon('folder')}${$t('Изменить папки…')}</button>`);
  head.querySelector('button').onclick = open;
  g.append(head);
  if (ok(roots) && (roots.roots || []).length) {
    for (const r of roots.roots) g.append(h(`<div class="row sub-row"><div class="lbl"><b>${esc(r.displayName || r.absolutePath)}</b><small>${esc(r.absolutePath)}</small></div><span class="st-count">${(r.trackCount || 0).toLocaleString()}</span></div>`));
  }
  g.append(note($t('Папки добавляются и удаляются только в родном окне — foobar2000 не даёт сделать это из темы. Новые файлы в этих папках медиатека находит сама.')));
}

/* ---------------------------------------------------------------- Advanced */
let advTree = null;
async function loadAdvanced() {
  if (advTree) return advTree;
  const r = await call('config.getAdvancedConfig', {});
  if (!ok(r)) return null;
  const flat = [];
  const walk = (list, path) => { for (const e of list || []) { if (e.type === 'branch') walk(e.children, [...path, e.name]); else flat.push({ ...e, path }); } };
  walk(r.entries, []);
  advTree = { entries: r.entries, flat };
  return advTree;
}

function advControl(e, onChange) {
  const isDefault = e.defaultValue === undefined || String(e.value) === String(e.defaultValue);
  const el = h(`<div class="row adv-row${isDefault ? '' : ' changed'}"><div class="lbl"><b>${esc(e.name)}</b>${e.path && e.path.length ? `<small>${esc(e.path.join(' › '))}</small>` : ''}</div><div class="adv-ctl"></div></div>`);
  const ctl = el.querySelector('.adv-ctl');
  const write = async (value) => {
    const r = await call('config.setAdvancedConfigValue', { guid: e.guid, value });
    if (!ok(r)) { fail(r); return false; }
    const back = await call('config.getAdvancedConfigValue', { guid: e.guid });
    e.value = ok(back) ? (e.type === 'integer' ? String(back.value) : back.value) : value;
    onChange && onChange(); return true;
  };
  if (e.type === 'checkbox') {
    ctl.append(h('<label class="toggle"><input type="checkbox"><i></i></label>'));
    const inp = ctl.querySelector('input'); inp.checked = !!e.value;
    inp.onchange = async () => { if (!(await write(inp.checked))) inp.checked = !inp.checked; };
  } else if (e.type === 'radio') {
    const b = h(`<button class="btn sm adv-radio${e.value ? ' on' : ''}">${e.value ? $t('Выбрано') : $t('Выбрать')}</button>`);
    b.onclick = () => { if (!e.value) write(true); };
    ctl.append(b);
  } else if (e.type === 'integer' || e.type === 'string') {
    const inp = h(`<input class="st-input adv-input" spellcheck="false" ${e.type === 'integer' ? 'inputmode="numeric"' : ''}>`);
    inp.value = e.value == null ? '' : String(e.value);
    inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') inp.blur(); if (ev.key === 'Escape') { inp.value = String(e.value ?? ''); inp.blur(); } });
    inp.onchange = async () => { if (e.type === 'integer' && !/^-?\d+$/.test(inp.value.trim())) { toast($t('Нужно целое число')); inp.value = String(e.value ?? ''); return; } if (!(await write(e.type === 'integer' ? inp.value.trim() : inp.value))) inp.value = String(e.value ?? ''); };
    ctl.append(inp);
  } else ctl.append(h(`<small class="adv-na">${$t('меняется только в родном окне')}</small>`));
  if (!isDefault && e.type !== 'radio') {
    const rs = h(`<button class="icon-btn adv-reset" title="${$t('Вернуть по умолчанию: {0}', esc(String(e.defaultValue)))}">${icon('refresh', 14)}</button>`);
    rs.onclick = async () => { const r = await call('config.resetAdvancedConfig', { guid: e.guid }); if (!ok(r)) return fail(r); const back = await call('config.getAdvancedConfigValue', { guid: e.guid }); if (ok(back)) e.value = e.type === 'integer' ? String(back.value) : back.value; onChange && onChange(); };
    ctl.append(rs);
  }
  return el;
}

function fillAdvanced(g) {
  const head = row($t('Расширенные настройки'), $t('Все параметры со страницы Advanced, с поиском. Меняйте, только если знаете, зачем: часть вступает в силу после перезапуска foobar2000'),
    `<label class="st-search adv-search">${icon('search')}<input type="search" placeholder="${$t('Например: buffer, cue, tag')}" spellcheck="false"></label>`);
  const list = h('<div class="adv-list"></div>');
  g.append(head, list);
  const q = head.querySelector('input');
  q.addEventListener('keydown', (e) => e.stopPropagation());
  let tree = null;
  const draw = () => {
    list.innerHTML = '';
    if (!tree) { list.append(unavailable()); return; }
    const s = q.value.trim().toLowerCase();
    if (s.length >= 2) {
      const hits = tree.flat.filter((e) => e.name.toLowerCase().includes(s) || e.path.join(' ').toLowerCase().includes(s));
      hits.slice(0, 60).forEach((e) => list.append(advControl(e, draw)));
      if (!hits.length) list.append(note($t('Ничего не нашлось')));
      else if (hits.length > 60) list.append(note($t('Показаны первые 60 из {0} — уточните запрос', hits.length)));
      return;
    }
    // no query: the tree, one level open at a time
    const branch = (entries, depth) => {
      const box = h('<div class="adv-branch"></div>');
      for (const e of entries || []) {
        if (e.type === 'branch') {
          const d = h(`<details class="adv-d" style="--d:${depth}"><summary>${icon('chev', 12)}<span>${esc(e.name)}</span></summary></details>`);
          d.addEventListener('toggle', () => { if (d.open && d.children.length === 1) d.append(branch(e.children, depth + 1)); }, { once: false });
          box.append(d);
        } else box.append(advControl({ ...e, path: [] }, draw));
      }
      return box;
    };
    list.append(branch(tree.entries, 0));
  };
  let loading = null;
  const ensure = () => (loading ||= loadAdvanced().then((t) => { tree = t; draw(); }));
  q.addEventListener('input', () => { ensure().then(draw); });
  list.append(h(`<div class="row"><button class="btn sm">${$t('Показать все параметры')}</button></div>`));
  list.querySelector('button').onclick = () => ensure();
}

/* ---------------------------------------------------------------- the section */
export function fb2kGroups(group, actions, button) {
  const mk = (title, fill) => { const g = group(title); fill(g).catch((e) => { g.append(unavailable()); console.warn('[Gatefold] fb2k prefs', e); }); return g; };
  const adv = group($t('Advanced'));
  fillAdvanced(adv);
  return [
    mk($t('Вывод звука'), fillOutput),
    mk('ReplayGain', fillReplayGain),
    mk('DSP', fillDsp),
    mk($t('Плейлист'), fillBehaviour),
    mk($t('Медиатека'), fillLibrary),
    adv,
    group('', actions(
      button($t('{0}Все настройки foobar2000…', icon('gear')), nativePrefs),
      button($t('{0}Консоль', icon('list')), () => call('misc.showConsole')))),
  ];
}
