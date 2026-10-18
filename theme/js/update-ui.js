/* Gatefold · update-ui.js — where updates show up: a pill in the sidebar, a sheet with the release
   notes and one «Update» button, a «what's new» note after the reload, and the Settings section. */
import { call, esc } from './bridge.js';
import { $, h, icon, toast } from './ui.js';
import { $t, lang } from './i18n.js';
import { VERSION, REPO } from './version.js';
import { settings, setSetting } from './settings.js';
import * as U from './updater.js';

const pill = $('updPill');
let sheet = null;

function render() {
  const a = U.available();
  if (pill) {
    pill.hidden = !a;
    if (a) { $('updPillVer').textContent = `${VERSION} → ${a.version}`; pill.classList.toggle('busy', U.state.installing); }
  }
  if (sheet) fillSheet();
  document.querySelectorAll('[data-upd-slot]').forEach(renderSettingsInto);
}
U.events.addEventListener('change', render);
pill && pill.addEventListener('click', openSheet);

function openExt(url) { call('shell.openExternal', { url }); }

export function openSheet() {
  if (!U.available()) return;
  if (!sheet) {
    sheet = h(`<div class="upd-veil"><div class="upd-sheet" role="dialog" aria-modal="true"><button class="icon-btn upd-x" title="${$t('Закрыть')}">${icon('x', 16)}</button><div class="upd-body"></div></div></div>`);
    document.body.appendChild(sheet);
    sheet.addEventListener('click', (e) => {
      if (e.target === sheet || e.target.closest('.upd-x') || e.target.closest('[data-u=later]')) { if (!U.state.installing) closeSheet(); return; }
      const b = e.target.closest('[data-u]'); const a = e.target.closest('a[data-href]');
      if (a) { e.preventDefault(); openExt(a.dataset.href); }
      if (!b) return;
      if (b.dataset.u === 'go') U.install();
      if (b.dataset.u === 'page') openExt(U.available().html);
      if (b.dataset.u === 'setup') openExt(U.available().setup || U.available().html);
    });
    addEventListener('keydown', (e) => { if (sheet && sheet.classList.contains('on') && e.key === 'Escape' && !U.state.installing) closeSheet(); }, true);
  }
  fillSheet();
  requestAnimationFrame(() => sheet.classList.add('on'));
}
function closeSheet() { sheet && sheet.classList.remove('on'); }

function fillSheet() {
  const a = U.available(); if (!a) { closeSheet(); return; }
  const st = U.state;
  const date = a.date ? new Date(a.date).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const busy = st.installing;
  sheet.querySelector('.upd-body').innerHTML = `
    <div class="upd-head"><div class="upd-badge">${icon('sparkle', 22)}</div><div>
      <div class="kicker">${$t('Доступно обновление')}</div>
      <h3>Gatefold ${esc(a.version)}</h3>
      <div class="sub">${$t('Сейчас установлена {0}', esc(VERSION))}${date ? ' · ' + esc(date) : ''}</div></div></div>
    <div class="upd-notes">${U.notesHtml(a.notes) || `<p>${$t('Описание изменений — на странице релиза.')}</p>`}</div>
    ${busy ? `<div class="upd-progress"><div class="upd-stage">${esc(st.stage)}</div><div class="progress"><i style="width:${Math.round(st.progress * 100)}%"></i></div></div>` : ''}
    ${st.error ? `<div class="upd-err">${esc(st.error)}</div>` : ''}
    <div class="upd-acts">
      ${st.needsSetup ? `<button class="btn primary" data-u="setup">${icon('download')}${$t('Скачать установщик')}</button>`
        : `<button class="btn primary" data-u="go" ${busy ? 'disabled' : ''}>${icon('download')}${busy ? $t('Обновляю…') : $t('Обновить сейчас')}</button>`}
      <button class="btn" data-u="page" ${busy ? 'disabled' : ''}>${icon('link')}${$t('Страница релиза')}</button>
      <span class="upd-gap"></span>
      <button class="btn" data-u="later" ${busy ? 'disabled' : ''}>${$t('Позже')}</button>
    </div>
    <p class="upd-fine">${$t('Скачивается с GitHub, проверяется по контрольной сумме; прежняя версия сохраняется и её можно вернуть в Настройках.')}</p>`;
}

/* Settings → «Обновления» */
export function settingsSection() {
  const el = h('<div data-upd-slot></div>');
  renderSettingsInto(el);
  return el;
}
function renderSettingsInto(el) {
  const a = U.available(), st = U.state, info = st.info;
  const when = info && info.checkedAt ? new Date(info.checkedAt).toLocaleString(lang, { dateStyle: 'short', timeStyle: 'short' }) : '';
  const status = !U.enabled() ? $t('Проверка обновлений появится в опубликованной версии')
    : st.checking ? $t('Проверяю…') : a ? $t('Доступна версия {0}', a.version) : st.error ? $t('Не удалось проверить: {0}', st.error) : when ? $t('Установлена последняя версия · проверено {0}', when) : $t('Ещё не проверялось');
  el.innerHTML = `
    <div class="row"><div class="lbl"><b>Gatefold ${esc(VERSION)}</b><small>${esc(status)}</small></div>
      ${a ? `<button class="btn sm primary" data-x="open">${icon('download')}${$t('Обновить до {0}', esc(a.version))}</button>` : `<button class="btn sm" data-x="check" ${!U.enabled() || st.checking ? 'disabled' : ''}>${icon('refresh')}${$t('Проверить')}</button>`}</div>
    <div class="row"><div class="lbl"><b>${$t('Проверять автоматически')}</b><small>${$t('Раз в 12 часов спрашивает GitHub о новом релизе. Устанавливается только по вашей кнопке')}</small></div><label class="toggle"><input type="checkbox" ${settings.updateCheck ? 'checked' : ''} data-x="auto"><i></i></label></div>
    ${U.canRollback() ? `<div class="row"><div class="lbl"><b>${$t('Вернуть предыдущую версию')}</b><small>${$t('Резервная копия, сохранённая перед обновлением')}</small></div><button class="btn sm" data-x="rollback">${$t('Вернуть')}</button></div>` : ''}
    ${U.enabled() ? `<div class="row"><div class="lbl"><b>${$t('Все релизы и история изменений')}</b><small>github.com/${esc(REPO)}</small></div><button class="btn sm" data-x="page">${icon('link')}GitHub</button></div>` : ''}`;
  el.onclick = (e) => {
    const b = e.target.closest('[data-x]'); if (!b || b.tagName === 'INPUT') return;
    if (b.dataset.x === 'check') U.check({ force: true });
    if (b.dataset.x === 'open') openSheet();
    if (b.dataset.x === 'rollback' && confirm($t('Вернуть предыдущую версию Gatefold? Интерфейс перезапустится.'))) U.rollback().then((r) => { if (!r) toast($t('Резервная копия не найдена')); });
    if (b.dataset.x === 'page') openExt(`https://github.com/${REPO}/releases`);
  };
  el.querySelector('[data-x=auto]').onchange = (e) => { setSetting('updateCheck', e.target.checked); if (e.target.checked) U.check(); };
}

/* start-up: a quiet check a little after launch; the «what's new» note once after an update */
export function init() {
  render();
  const d = U.justUpdated();
  if (d && !d.ack) {
    U.ackUpdated();
    setTimeout(() => toast(`${$t('Gatefold обновлён до {0}', esc(d.to))} · <a class="link" data-href="${esc(d.html || '')}">${$t('что нового')}</a>`, { ms: 9000 }), 1500);
    document.addEventListener('click', (e) => { const a = e.target.closest('.toast a[data-href]'); if (a && a.dataset.href) openExt(a.dataset.href); });
  }
  setTimeout(() => U.check(), 20000);
  setInterval(() => U.check(), 3 * 3600e3);
}
