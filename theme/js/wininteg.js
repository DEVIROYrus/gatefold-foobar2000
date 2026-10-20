/*
 * Gatefold · wininteg.js — Windows around the window: taskbar thumbnail buttons, progress on the
 * taskbar button, and a notification-area (tray) icon with a player menu.
 *
 * The component already puts ⏮ ⏯ ⏭ on the thumbnail by itself, with Chinese tooltips and no like
 * button; Gatefold installs its own set once (Windows allows one install per window) and then only
 * updates it: translated tooltips, the right ⏯ icon, and ♡ that follows the playing track.
 * The progress mirror of the component is off by default, so Gatefold draws it (once a second).
 * Tray menu rows that control playback are declared as `playbackAction`: they run natively and
 * keep working while the window is hidden to the tray and the page is asleep. «Show Gatefold» and
 * «Exit» are the component's native rows for the same reason.
 */
import { call, ok, on, log } from './bridge.js';
import { settings, onSettings } from './settings.js';
import { $t } from './i18n.js';
import * as ICO from './icons-win.js';

let host = null;
const st = { buttons: false, playing: null, liked: null, trackKey: '', tray: false, prog: '' };

/* ---------------------------------------------------------------- taskbar */
async function installButtons() {
  if (st.buttons || !settings.taskbarButtons) return;
  const r = await call('taskbar.setThumbnailButtons', { buttons: [
    { id: 'prev', icon: ICO.prev, tooltip: $t('Предыдущий') },
    { id: 'pp', icon: ICO.play, tooltip: $t('Воспроизвести') },
    { id: 'next', icon: ICO.next, tooltip: $t('Следующий') },
    { id: 'like', icon: ICO.heart, tooltip: $t('В понравившиеся') },
  ] });
  st.buttons = ok(r);
  st.playing = null; st.liked = null;
  if (!st.buttons) log('taskbar buttons', r);
}
function syncButtons() {
  if (!st.buttons) return;
  const playing = host.state() === 'playing';
  if (playing !== st.playing) {
    st.playing = playing;
    call('taskbar.updateButton', { id: 'pp', icon: playing ? ICO.pause : ICO.play, tooltip: playing ? $t('Приостановить') : $t('Воспроизвести') });
  }
  const t = host.track();
  const liked = !!(t && host.liked(t));
  if (liked !== st.liked) {
    st.liked = liked;
    call('taskbar.updateButton', { id: 'like', icon: liked ? ICO.heartFilled : ICO.heart, tooltip: liked ? $t('Убрать из понравившихся') : $t('В понравившиеся'), enabled: !!t });
  }
}
function setButtonsVisible(v) {
  if (!st.buttons) return;
  for (const id of ['prev', 'pp', 'next', 'like']) call('taskbar.updateButton', { id, visible: v });
}
function syncProgress() {
  if (!settings.taskbarProgress) { if (st.prog !== 'none') { st.prog = 'none'; call('taskbar.setProgress', { state: 'none' }); } return; }
  const s = host.state(), dur = host.dur(), pos = host.pos();
  const state = s === 'stopped' || !dur ? 'none' : s === 'paused' ? 'paused' : 'normal';
  const value = state === 'none' ? 0 : Math.max(0, Math.min(1, pos / dur));
  const key = state + ':' + value.toFixed(3);
  if (key === st.prog) return;
  st.prog = key;
  call('taskbar.setProgress', state === 'none' ? { state } : { state, value });
}

/* ---------------------------------------------------------------- tray */
const trackLine = (t) => (t ? [t.title, t.artist].filter(Boolean).join(' — ') : 'Gatefold').slice(0, 120);
function menuZones() {
  const t = host.track();
  return {
    top: [{ id: 'np', type: 'nowplaying', title: t ? t.title : 'Gatefold', subtitle: t ? [t.artist, t.album].filter(Boolean).join(' · ') : $t('Ничего не играет') }, { type: 'separator' }],
    playback: [
      { id: 'pp', label: $t('Воспроизведение / пауза'), playbackAction: 'play-pause' },
      { id: 'prev', label: $t('Предыдущий'), playbackAction: 'previous' },
      { id: 'next', label: $t('Следующий'), playbackAction: 'next' },
      { id: 'like', label: $t('Нравится'), checked: !!(t && host.liked(t)), enabled: !!t },
    ],
    bottom: [
      { type: 'separator' },
      ...(host.openMini ? [{ id: 'mini', label: $t('Мини-плеер') }] : []),
      { id: '_sys_show', label: $t('Показать Gatefold') },
      { id: '_sys_exit', label: $t('Выход') },
    ],
    config: { render: 'webview', autoNowPlaying: true, showPlaybackControls: false, showSystemItems: false, backdrop: 'acrylic', backdropDarkMode: document.documentElement.dataset.scheme !== 'light' },
  };
}
async function trayOn() {
  if (!st.tray) {
    const r = await call('tray.create', { icon: ICO.tray, tooltip: trackLine(host.track()) });
    if (!ok(r)) { log('tray', r); return; }
    st.tray = true;
  }
  const z = await call('tray.setMenuZones', menuZones());
  if (!ok(z)) { const zs = menuZones(); zs.config.render = 'native'; await call('tray.setMenuZones', zs); }
  applyHide();
}
async function trayOff() {
  await call('tray.setMinimizeToTray', { enabled: false });
  await call('tray.setCloseToTray', { enabled: false });
  if (st.tray) { await call('tray.destroy'); st.tray = false; }
}
function applyHide() {
  // never hide the window to a tray that does not exist: there would be no way back
  call('tray.setMinimizeToTray', { enabled: st.tray && !!settings.minimizeToTray });
  call('tray.setCloseToTray', { enabled: st.tray && !!settings.closeToTray });
}
function syncTray() {
  if (!st.tray) return;
  const t = host.track();
  const key = t ? (t.absolutePath || '') + '|' + t.title : '';
  if (key !== st.trackKey) {
    st.trackKey = key;
    call('tray.setTooltip', { tooltip: trackLine(t) });
    call('tray.setMenuZones', menuZones());
  } else call('tray.setMenuItemState', { id: 'like', checked: !!(t && host.liked(t)), enabled: !!t });
}
function showMain() { call('window.focus', { windowId: 'main' }); }

/* ---------------------------------------------------------------- wiring */
export function apply() {
  if (!host) return;
  if (settings.taskbarButtons) { if (st.buttons) setButtonsVisible(true); else installButtons().then(syncButtons); }
  else setButtonsVisible(false);
  if (settings.taskbarButtons && st.buttons) { st.playing = null; st.liked = null; syncButtons(); }
  st.prog = ''; syncProgress();
  if (settings.trayIcon) trayOn(); else trayOff();
}

export function init(h) {
  host = h;
  on('taskbar:buttonClicked', (d) => {
    if (d.id === 'prev') call('playback.previous');
    else if (d.id === 'next') call('playback.next');
    else if (d.id === 'pp') host.playPause();
    else if (d.id === 'like') host.toggleLike();
  });
  on('tray:menuItemClicked', (d) => {
    if (d.id === 'like') host.toggleLike();
    else if (d.id === 'mini' && host.openMini) host.openMini();
  });
  on('tray:click', showMain);
  on('tray:doubleClick', showMain);
  onSettings((k) => { if (['taskbarButtons', 'taskbarProgress', 'trayIcon', 'minimizeToTray', 'closeToTray', '*'].includes(k)) apply(); });
  apply();
  setInterval(() => { syncButtons(); syncProgress(); syncTray(); }, 1000);
}
/** something the buttons show changed right now (play state, like): no need to wait for the tick */
export function poke() { syncButtons(); syncTray(); syncProgress(); }
