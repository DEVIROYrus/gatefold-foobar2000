/*
 * Gatefold · youtube.js — YouTube as a player inside Gatefold, not a browser tab.
 *
 * The video is the official IFrame Player (youtube-nocookie.com) with YouTube's own
 * controls switched off; everything around it is Gatefold's: search with suggestions
 * and pasted links, a queue (search results or a playlist), history, seek bar with
 * buffer, volume, speed, autoplay, theater mode and true fullscreen with auto-hiding
 * controls. Colours come from the video's thumbnail like album pages take them from
 * covers.
 *
 * One iframe for the whole session: moving an iframe in the DOM reloads it, so the
 * player lives in a fixed layer (#ytHost) that is laid over its slot in the YouTube
 * view, shrinks into a mini player when you go elsewhere, or covers the window in
 * fullscreen — the video never restarts.
 *
 * Playback courtesy: when the video starts, foobar2000 pauses; when foobar2000 starts,
 * the video pauses. A transparent shield over the top three quarters of the video keeps
 * clicks and hotkeys in Gatefold (click = pause, double click = fullscreen); the bottom
 * strip stays live so YouTube's «Skip ad» button can be pressed.
 */
import { call, ok, on, esc, fmtTime, debounce, log } from './bridge.js';
import { router, onRoute, $, h, icon, toast, popupMenu } from './ui.js';
import * as App from './app.js';
import * as Theme from './theme.js';
import * as YS from './yt-search.js';
import { setFullscreen } from './winfs.js';

import { $t } from './i18n.js';
const LS = 'aurora.yt.';
const ls = {
  get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch {} },
};
const S = {
  built: false, player: null, ready: false, apiP: null,
  cur: null, queue: [], qi: -1, results: [], cont: '', q: '', loadingMore: false,
  tab: 'next', state: -1, vol: ls.get('vol', 80), muted: false, rate: 1, auto: ls.get('auto', true),
  theater: ls.get('theater', false), full: false, histT: 0, pendingStart: 0, listMode: null,
  quality: ls.get('quality', 'auto'), actualQ: '', popup: '',
};
/* Quality. The IFrame API's setPlaybackQuality() has been a no-op since 2019: YouTube picks the
   stream from the player's size in physical pixels (and the bandwidth). So a chosen quality is
   reached the way YouTube itself measures it — the player is laid out at that resolution and
   scaled to fit the stage. 1080p therefore really asks for 1080 lines; the bandwidth can still
   make YouTube go lower, which the menu shows as «сейчас». */
const QUALITIES = [
  { id: 'auto', label: $t('Авто'), h: 0 },
  { id: 'hd2160', label: '2160p', tag: '4K', h: 2160 },
  { id: 'hd1440', label: '1440p', tag: 'QHD', h: 1440 },
  { id: 'hd1080', label: '1080p', tag: 'HD', h: 1080 },
  { id: 'hd720', label: '720p', tag: 'HD', h: 720 },
  { id: 'large', label: '480p', h: 480 },
  { id: 'medium', label: '360p', h: 360 },
  { id: 'small', label: '240p', h: 240 },
  { id: 'tiny', label: '144p', h: 144 },
];
const qOf = (id) => QUALITIES.find((q) => q.id === id) || QUALITIES[0];
const qLabel = (id) => (id && id !== 'auto' && id !== 'unknown' && id !== 'default' ? (qOf(id).id === 'auto' && id !== 'auto' ? id : qOf(id).label) : '');
const view = $('view-youtube');
let host, frameBox, shield, errBox, ctrl, slot, sideList, grid, emptyBox, input, sugg;

// ================================================================ build once
function build() {
  if (S.built) return; S.built = true;
  const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = 'css/youtube.css'; document.head.appendChild(css);
  view.innerHTML = `
    <div class="yt-top">
      <div class="yt-brand">${icon('yt')}<b>YouTube</b></div>
      <form class="yt-search" autocomplete="off">
        ${icon('search')}<input type="text" spellcheck="false" placeholder="${YS.mode() === 'off' ? $t('Ссылка на видео или плейлист YouTube') : $t('Поиск на YouTube или ссылка на видео')}">
        <kbd>/</kbd><button type="submit" class="btn primary sm">${$t('Найти')}</button>
        <div class="yt-sugg" role="listbox"></div>
      </form>
    </div>
    <div class="yt-body">
      <div class="yt-main scroller">
        <div class="yt-stage-wrap">
          <div class="yt-stage" id="ytSlot"></div>
          <div class="yt-info">
            <h2 class="yt-title"></h2>
            <div class="yt-meta"></div>
            <div class="yt-ctrl">
              <div class="yt-seekrow"><span class="num yt-t0">0:00</span><div class="yt-seek"><i class="buf"></i><i class="fill"></i><i class="knob"></i><span class="tip num"></span></div><span class="num yt-t1">0:00</span></div>
              <div class="yt-btnrow">
                <button class="icon-btn" data-a="prev" title="${$t('Предыдущее (P)')}">${icon('prev')}</button>
                <button class="yt-play" data-a="play" title="${$t('Пауза / воспроизведение (Пробел)')}">${icon('play')}</button>
                <button class="icon-btn" data-a="next" title="${$t('Следующее (N)')}">${icon('next')}</button>
                <div class="yt-vol"><button class="icon-btn" data-a="mute" title="${$t('Без звука (M)')}">${icon('vol')}</button><input class="range" type="range" min="0" max="100" step="1" aria-label="${$t('Громкость видео')}"></div>
                <span class="yt-gap"></span>
                <button class="btn sm yt-q" data-a="quality" title="${$t('Качество видео')}">${icon('hd')}<span>${$t('Авто')}</span><i class="qtag"></i></button>
                <button class="btn sm yt-rate" data-a="rate" title="${$t('Скорость')}">${icon('speed')}<span>1×</span></button>
                <button class="btn sm yt-auto" data-a="auto" title="${$t('Следующее видео начнётся само')}">${$t('Автовоспроизведение')}</button>
                <button class="icon-btn" data-a="theater" title="${$t('Кинотеатр (T)')}">${icon('pip')}</button>
                <button class="icon-btn" data-a="full" title="${$t('Во весь экран (F)')}">${icon('expand')}</button>
                <button class="icon-btn" data-a="win" title="${$t('Смотреть в окне YouTube (полный сайт)')}">${icon('window')}</button>
                <button class="icon-btn" data-a="ext" title="${$t('Открыть в браузере')}">${icon('link')}</button>
                <button class="icon-btn" data-a="close" title="${$t('Закрыть видео')}">${icon('x')}</button>
              </div>
            </div>
          </div>
        </div>
        <div class="yt-empty"></div>
        <div class="yt-grid"></div>
      </div>
      <aside class="yt-side">
        <div class="seg yt-tabs"><button data-t="next">${$t('Очередь')}</button><button data-t="results">${$t('Результаты')}</button><button data-t="history">${$t('История')}</button></div>
        <div class="yt-list scroller"></div>
      </aside>
    </div>`;
  slot = $('ytSlot'); ctrl = view.querySelector('.yt-ctrl'); sideList = view.querySelector('.yt-list');
  grid = view.querySelector('.yt-grid'); emptyBox = view.querySelector('.yt-empty');
  input = view.querySelector('.yt-search input'); sugg = view.querySelector('.yt-sugg');

  host = h(`<div id="ytHost" class="yt-host" hidden>
    <div class="yt-frame"><div id="ytFrame"></div></div>
    <div class="yt-shield" title=""></div>
    <div class="yt-err"></div>
    <div class="yt-mini"><div class="yt-mini-t"></div>
      <button class="icon-btn" data-a="play" title="${$t('Пауза / воспроизведение')}">${icon('play')}</button>
      <button class="icon-btn" data-a="open" title="${$t('Развернуть')}">${icon('expand')}</button>
      <button class="icon-btn" data-a="close" title="${$t('Закрыть')}">${icon('x')}</button></div>
    <div class="yt-fsbar"></div>
  </div>`);
  document.body.appendChild(host);
  // a thumbnail that fails (removed video, no network) fades out instead of showing a broken-image glyph
  view.addEventListener('error', (e) => { if (e.target.tagName === 'IMG') e.target.classList.add('broken'); }, true);
  frameBox = host.querySelector('.yt-frame'); shield = host.querySelector('.yt-shield'); errBox = host.querySelector('.yt-err');

  // ---- search box
  const form = view.querySelector('.yt-search');
  form.addEventListener('submit', (e) => { e.preventDefault(); hideSugg(); submit(input.value); });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const items = [...sugg.querySelectorAll('div')]; const cur = sugg.querySelector('.on'); let i = items.indexOf(cur);
    if (e.key === 'ArrowDown' && items.length) { e.preventDefault(); i = (i + 1) % items.length; items.forEach((x, k) => x.classList.toggle('on', k === i)); input.value = items[i].textContent; }
    else if (e.key === 'ArrowUp' && items.length) { e.preventDefault(); i = (i - 1 + items.length) % items.length; items.forEach((x, k) => x.classList.toggle('on', k === i)); input.value = items[i].textContent; }
    else if (e.key === 'Escape') { if (sugg.childElementCount) hideSugg(); else input.blur(); }
  });
  input.addEventListener('input', debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2 || YS.parseLink(q)) { hideSugg(); return; }
    const list = await YS.suggest(q);
    if (input.value.trim() !== q || document.activeElement !== input) return;
    sugg.innerHTML = list.map((s) => `<div role="option">${esc(s)}</div>`).join('');
    sugg.classList.toggle('on', list.length > 0);
  }, 200));
  input.addEventListener('blur', () => setTimeout(hideSugg, 150));
  sugg.addEventListener('mousedown', (e) => { const d = e.target.closest('div[role=option]'); if (d) { e.preventDefault(); input.value = d.textContent; hideSugg(); submit(d.textContent); } });

  // ---- controls (the same element serves the page and the fullscreen overlay)
  const act = (a, el) => {
    if (a === 'play') toggle();
    if (a === 'prev') step(-1);
    if (a === 'next') step(1);
    if (a === 'mute') setMuted(!S.muted);
    if (a === 'auto') { S.auto = !S.auto; ls.set('auto', S.auto); syncButtons(); }
    if (a === 'theater') { S.theater = !S.theater; ls.set('theater', S.theater); view.classList.toggle('theater', S.theater); requestAnimationFrame(place); }
    if (a === 'full') setFull(!S.full);
    if (a === 'ext' && S.cur) call('shell.openExternal', { url: `https://www.youtube.com/watch?v=${S.cur.id}&t=${Math.floor(time())}s` });
    if (a === 'close') closeVideo();
    if (a === 'open') router.go('youtube');
    if (a === 'rate') rateMenu(el);
    if (a === 'quality') qualityMenu(el);
    if (a === 'win' && S.cur) openWatchWindow(S.cur, time());
  };
  for (const box of [ctrl, host.querySelector('.yt-mini')]) box.addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) { e.stopPropagation(); act(b.dataset.a, b); } });
  const vol = ctrl.querySelector('.yt-vol input');
  vol.addEventListener('input', () => setVol(+vol.value));
  bindSeek(ctrl.querySelector('.yt-seek'));

  // ---- shield: click = pause, double click = fullscreen; the moving mouse shows the fullscreen controls
  let clickT = 0;
  shield.addEventListener('click', () => { if (host.classList.contains('mini')) { router.go('youtube'); return; } clearTimeout(clickT); clickT = setTimeout(toggle, 220); });
  shield.addEventListener('dblclick', () => { clearTimeout(clickT); setFull(!S.full); });
  host.addEventListener('pointermove', () => { if (!S.full) return; host.classList.add('show-ui'); clearTimeout(S.uiT); S.uiT = setTimeout(() => host.classList.remove('show-ui'), 2600); });

  // ---- side tabs and lists
  view.querySelector('.yt-tabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-t]'); if (b) { S.tab = b.dataset.t; renderSide(); } });
  sideList.addEventListener('click', listClick);
  grid.addEventListener('click', listClick);
  const main = view.querySelector('.yt-main');
  main.addEventListener('scroll', () => {
    requestAnimationFrame(place);
    // endless results: the next page starts loading a screen before the end
    if (!S.cur && S.cont && !S.loadingMore && main.scrollTop + main.clientHeight * 2 > main.scrollHeight) loadMore();
  }, { passive: true });
  new ResizeObserver(() => place()).observe(slot);
  new ResizeObserver(() => applyQuality()).observe(frameBox);
  addEventListener('resize', debounce(place, 60));
  view.classList.toggle('theater', S.theater);

  // ---- a pasted YouTube link plays at once (anywhere in the view)
  view.addEventListener('paste', (e) => {
    if (e.target === input) return;
    const t = e.clipboardData && e.clipboardData.getData('text');
    if (YS.parseLink(t)) { e.preventDefault(); submit(t); }
  });
  renderEmpty(); renderSide(); syncButtons();
}
const hideSugg = () => { sugg.innerHTML = ''; sugg.classList.remove('on'); };

// ================================================================ player
function api() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (!S.apiP) S.apiP = new Promise((res, rej) => {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { try { prev && prev(); } catch {} res(window.YT); };
    const s = document.createElement('script'); s.src = 'https://www.youtube.com/iframe_api'; s.async = true;
    s.onerror = () => { S.apiP = null; rej(new Error($t('нет связи с YouTube'))); };
    document.head.appendChild(s);
    setTimeout(() => { if (!(window.YT && window.YT.Player)) { S.apiP = null; rej(new Error($t('YouTube не отвечает'))); } }, 20000);
  });
  return S.apiP;
}
async function ensurePlayer(first) {
  if (S.player) return S.player;
  const YT = await api();
  return new Promise((res) => {
    S.player = new YT.Player('ytFrame', {
      host: 'https://www.youtube-nocookie.com', width: '100%', height: '100%',
      videoId: first.id || undefined,
      playerVars: { autoplay: 1, controls: 0, rel: 0, playsinline: 1, iv_load_policy: 3, disablekb: 1, fs: 0, modestbranding: 1, origin: location.origin, start: first.start || 0, ...(S.quality !== 'auto' ? { vq: S.quality } : {}) },
      events: {
        onReady: () => { S.ready = true; S.player.setVolume(S.vol); if (S.muted) S.player.mute(); applyQuality(); res(S.player); },
        onStateChange: (e) => stateChanged(e.data),
        onError: (e) => playerError(e.data),
        onPlaybackRateChange: (e) => { S.rate = e.data; syncButtons(); },
        onPlaybackQualityChange: (e) => { S.actualQ = e.data; syncButtons(); },
      },
    });
  });
}
const P = () => (S.ready ? S.player : null);
const time = () => { try { return P() ? P().getCurrentTime() || 0 : 0; } catch { return 0; } };
const dur = () => { try { return P() ? P().getDuration() || 0 : 0; } catch { return 0; } };

/** play item {id, title?, channel?, …} (optionally a playlist link) */
async function play(item, { start = 0, list = null } = {}) {
  build();
  errBox.classList.remove('on'); errBox.innerHTML = '';
  S.cur = { ...item }; S.pendingStart = start;
  view.classList.add('has-video'); host.hidden = false;
  showInfo(); place(); tickStart();
  try {
    const first = !S.player;
    await ensurePlayer({ id: list ? '' : item.id, start });
    // a playlist: cue it to learn its video ids, then play from our own queue (see stateChanged)
    if (list) { S.listMode = { list, startId: item.id, start }; P().cuePlaylist({ list, listType: 'playlist', index: 0 }); return; }
    if (!first) P().loadVideoById({ videoId: item.id, startSeconds: start || 0 });
  } catch (e) {
    showError(`<b>${$t('YouTube недоступен')}</b><span>${esc(e.message)}</span>`);
    return;
  }
  if (!item.title) YS.oembed(item.id).then((m) => { if (S.cur && S.cur.id === item.id) { S.cur = { ...S.cur, ...m, ...Object.fromEntries(Object.entries(S.cur).filter(([, v]) => v)) }; showInfo(); renderSide(); } });
  paint(item.id);
  renderSide();
}
function stateChanged(st) {
  S.state = st;
  syncButtons();
  if (st === 5 && S.listMode) {            // a cued playlist: take its ids into our own queue
    const ids = (P().getPlaylist && P().getPlaylist()) || [];
    const lm = S.listMode; S.listMode = null;
    if (ids.length) {
      S.queue = ids.map((id) => ({ id, title: '', channel: '', thumb: YS.thumb(id) }));
      S.qi = Math.max(0, ids.indexOf(lm.startId));
      S.tab = 'next';
      fillTitles(S.queue);
      play(S.queue[S.qi], { start: lm.startId ? lm.start : 0 });
    } else showError(`<b>${$t('Плейлист пуст или скрыт')}</b><span>${$t('YouTube не отдал список видео.')}</span>`);
    return;
  }
  if (st === 1) {                           // playing
    if (App.player().state === 'playing') { call('playback.pause'); S.pausedFoobar = true; }
    const d = P().getVideoData && P().getVideoData();
    if (d && S.cur && d.video_id === S.cur.id && (!S.cur.title || !S.cur.channel)) { S.cur.title = S.cur.title || d.title; S.cur.channel = S.cur.channel || d.author; showInfo(); renderSide(); }
    clearTimeout(S.histT); S.histT = setTimeout(() => remember(S.cur), 10000);
  }
  if (st === 0) { clearTimeout(S.histT); remember(S.cur); if (S.auto && S.qi >= 0 && S.qi < S.queue.length - 1) step(1); }
}
function playerError(code) {
  const why = code === 101 || code === 150 || code === 152 ? $t('Владелец запретил показывать это видео вне YouTube.')
    : code === 100 ? $t('Видео удалено или скрыто.') : code === 2 ? $t('Неверная ссылка на видео.')
    : code === 153 ? $t('YouTube не принял запрос плеера (нет данных о сайте).') : $t('Плеер YouTube не смог воспроизвести видео.');
  const blocked = code === 101 || code === 150 || code === 152;
  const canNext = S.auto && S.qi >= 0 && S.qi < S.queue.length - 1;
  showError(`<b>${why}</b><span>${blocked ? '' : $t('Можно открыть его на YouTube')}${canNext && !blocked ? $t(' — или следующее начнётся через 4 секунды') : ''}.</span>
    <div class="yt-err-acts">${blocked ? `<button class="btn sm primary" data-e="win">${icon('window')}${$t('Смотреть в окне YouTube')}</button>` : ''}<button class="btn sm" data-e="ext">${icon('link')}${$t('В браузере')}</button>${canNext ? `<button class="btn sm" data-e="next">${icon('next')}${$t('Следующее')}</button>` : ''}</div>`);
  errBox.onclick = (e) => {
    const b = e.target.closest('[data-e]'); if (!b || !S.cur) return;
    if (b.dataset.e === 'win') openWatchWindow(S.cur, S.pendingStart || 0);
    if (b.dataset.e === 'ext') call('shell.openExternal', { url: 'https://www.youtube.com/watch?v=' + S.cur.id });
    if (b.dataset.e === 'next') step(1);
  };
  if (blocked && ls.get('autoWindow', false) && S.cur) { openWatchWindow(S.cur, S.pendingStart || 0); return; }
  if (canNext && !blocked) setTimeout(() => { if (errBox.classList.contains('on')) step(1); }, 4000);
}
function showError(html) { errBox.innerHTML = html; errBox.classList.add('on'); }
function toggle() {
  if (!P()) return;
  const st = P().getPlayerState();
  if (st === 1 || st === 3) P().pauseVideo(); else P().playVideo();
}
function step(d) {
  if (!S.queue.length) return;
  const i = S.qi + d;
  if (d < 0 && time() > 4) { P() && P().seekTo(0, true); return; }
  if (i < 0 || i >= S.queue.length) return;
  S.qi = i; play(S.queue[i]);
}
function setVol(v) { S.vol = Math.max(0, Math.min(100, Math.round(v))); ls.set('vol', S.vol); if (P()) { P().setVolume(S.vol); if (S.muted && S.vol > 0) setMuted(false); } syncButtons(); }
function setMuted(m) { S.muted = m; if (P()) m ? P().mute() : P().unMute(); syncButtons(); }
async function rateMenu(el) {
  const rates = (P() && P().getAvailablePlaybackRates && P().getAvailablePlaybackRates()) || [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const r = el.getBoundingClientRect();
  const id = await popupMenu(rates.map((x) => ({ id: String(x), label: x === 1 ? $t('Обычная') : x + '×', checked: x === S.rate })), r.left, r.top - 8 - rates.length * 32);
  if (id != null && id !== 'null' && P()) P().setPlaybackRate(+id);
}
// ---------------------------------------------------------------- quality
function iframeEl() { try { return (P() && P().getIframe && P().getIframe()) || frameBox.querySelector('iframe, .fakeyt'); } catch { return frameBox.querySelector('iframe'); } }
function applyQuality() {
  const f = iframeEl(); if (!f || !frameBox) return;
  const q = qOf(S.quality);
  const box = frameBox.getBoundingClientRect();
  if (!q.h || box.width < 2 || box.height < 2) { f.style.width = f.style.height = f.style.transform = f.style.transformOrigin = ''; return; }
  const dpr = window.devicePixelRatio || 1;
  // lay the player out so that its height is exactly q.h physical pixels, then scale it to the box
  const scale = (box.height * dpr) / q.h;
  f.style.transformOrigin = '0 0';
  f.style.width = box.width / scale + 'px';
  f.style.height = box.height / scale + 'px';
  f.style.transform = `scale(${scale})`;
  try { P() && P().setPlaybackQuality && P().setPlaybackQuality(q.id); } catch {}   // harmless where ignored
}
function setQuality(id) {
  S.quality = qOf(id).id; ls.set('quality', S.quality);
  applyQuality(); syncButtons();
  toast(S.quality === 'auto' ? $t('Качество: авто') : $t('Качество: {0}', qOf(S.quality).label), { ms: 2000 });
}
async function qualityMenu(el) {
  let avail = [];
  try { avail = (P() && P().getAvailableQualityLevels && P().getAvailableQualityLevels()) || []; } catch {}
  const has = new Set(avail);
  const now = S.actualQ || (P() && P().getPlaybackQuality && (() => { try { return P().getPlaybackQuality(); } catch { return ''; } })()) || '';
  const items = QUALITIES.filter((q) => q.id === 'auto' || !has.size || has.has(q.id)).map((q) => ({
    id: q.id, checked: q.id === S.quality,
    label: q.id === 'auto' ? `${$t('Авто')}${now && qLabel(now) ? $t(' · сейчас ') + qLabel(now) : ''}` : q.label + (q.tag ? '  ' + q.tag : '') + (q.id === now && S.quality !== 'auto' ? $t(' · играет') : ''),
  }));
  items.push({ type: 'sep' }, { id: 'aw', label: $t('Видео без встраивания — сразу в окне YouTube'), checked: ls.get('autoWindow', false) });
  const r = el.getBoundingClientRect();
  const id = await popupMenu(items, r.left, Math.max(8, r.top - 8 - items.length * 32));
  if (id == null || id === 'null') return;
  if (id === 'aw') { ls.set('autoWindow', !ls.get('autoWindow', false)); return; }
  setQuality(id);
}

// ---------------------------------------------------------------- the real YouTube page, in a foobar2000 window
/* Some owners forbid playback outside youtube.com (errors 101/150/152). That is decided by YouTube
   for the embedding page, and it is the owner's choice — Gatefold does not disguise itself to get
   round it. What it can do legitimately is show youtube.com itself: a separate WebView2 window of
   foobar2000 with the ordinary watch page, where these videos play as they do in a browser. */
async function openWatchWindow(item, at = 0) {
  if (!item || !item.id) return;
  try { P() && P().pauseVideo(); } catch {}
  if (App.player().state === 'playing') call('playback.pause');
  if (S.popup) { await call('window.closePopup', { windowId: S.popup }); S.popup = ''; }
  const b = await call('window.getBounds');
  const W = ok(b) && b.width ? b.width : 1600, H = ok(b) && b.height ? b.height : 1000;
  const width = Math.round(Math.min(1500, Math.max(900, W * 0.78))), height = Math.round(Math.min(1000, Math.max(620, H * 0.82)));
  const x = ok(b) && b.x != null ? Math.round(b.x + (W - width) / 2) : undefined, y = ok(b) && b.y != null ? Math.round(b.y + (H - height) / 2) : undefined;
  const url = `https://www.youtube.com/watch?v=${item.id}${at > 1 ? '&t=' + Math.floor(at) + 's' : ''}`;
  const r = await call('window.createPopup', { url, title: (item.title || 'YouTube') + ' — YouTube', width, height, minWidth: 640, minHeight: 400, ...(x != null ? { x, y } : {}), profile: 'standard', showInTaskbar: true });
  if (ok(r) && r.windowId) { S.popup = r.windowId; toast($t('Видео открыто в окне YouTube'), { ms: 2200 }); }
  else call('shell.openExternal', { url });
}

function closeVideo() {
  if (S.full) setFull(false);
  try { P() && P().stopVideo(); } catch {}
  clearTimeout(S.histT);
  S.cur = null; S.qi = -1;
  view.classList.remove('has-video'); host.hidden = true; host.classList.remove('mini');
  errBox.classList.remove('on');
  tickStop(); renderSide();
  if (S.results.length) renderGrid(); else renderEmpty();
}
async function setFull(onOff) {
  if (!S.cur) return;
  S.full = onOff;
  document.body.classList.toggle('yt-full', onOff);
  host.classList.toggle('full', onOff);
  const bar = host.querySelector('.yt-fsbar');
  if (onOff) { bar.appendChild(ctrl); host.classList.add('show-ui'); S.uiT = setTimeout(() => host.classList.remove('show-ui'), 2600); }
  else view.querySelector('.yt-info').appendChild(ctrl);
  // the whole window goes fullscreen too (without pinning it above other programs — winfs.js),
  // unless it already was: then leaving the video's fullscreen leaves the window as it was
  if (App.player().standalone) {
    if (onOff && !App.player().fullscreen) { const r = await setFullscreen(true); S.winFull = ok(r); }
    else if (!onOff && S.winFull) { S.winFull = false; await setFullscreen(false); }
  }
  place();
}

// ================================================================ layout: lay the player over its slot / mini / fullscreen
function place() {
  if (!host || host.hidden || !S.cur) return;
  const mini = router.current !== 'youtube' && !S.full;
  host.classList.toggle('mini', mini);
  if (S.full || mini) { host.style.left = host.style.top = host.style.width = host.style.height = host.style.clipPath = ''; return; }
  const r = slot.getBoundingClientRect();
  const m = document.getElementById('main').getBoundingClientRect();
  // clipped by the scroller: the video scrolls away with the page instead of floating over the header
  const top = Math.max(r.top, m.top), bottom = Math.min(r.bottom, m.bottom);
  host.style.left = r.left + 'px'; host.style.top = r.top + 'px'; host.style.width = r.width + 'px'; host.style.height = r.height + 'px';
  host.style.clipPath = bottom <= top ? 'inset(100% 0 0 0)' : `inset(${Math.max(0, top - r.top)}px 0 ${Math.max(0, r.bottom - bottom)}px 0 round 16px)`;
}

// ================================================================ ticking UI (only while there is a video)
let tick = 0;
function tickStart() { if (!tick) tick = setInterval(update, 250); }
function tickStop() { clearInterval(tick); tick = 0; }
function update() {
  if (!S.cur || !P()) return;
  if (document.visibilityState !== 'visible') return;
  const t = time(), d = dur(), frac = d ? Math.min(1, t / d) : 0;
  const seek = ctrl.querySelector('.yt-seek');
  if (!seek.classList.contains('drag')) {
    seek.style.setProperty('--p', (frac * 100).toFixed(3) + '%');
    ctrl.querySelector('.yt-t0').textContent = fmtTime(t);
  }
  let buf = 0; try { buf = P().getVideoLoadedFraction() || 0; } catch {}
  seek.style.setProperty('--b', (buf * 100).toFixed(2) + '%');
  ctrl.querySelector('.yt-t1').textContent = S.cur.live ? 'LIVE' : fmtTime(d);
  host.style.setProperty('--p', (frac * 100).toFixed(3) + '%');
}
function bindSeek(el) {
  const at = (e) => { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
  const tip = el.querySelector('.tip');
  el.addEventListener('pointermove', (e) => { const f = at(e); tip.textContent = fmtTime(f * dur()); tip.style.left = f * 100 + '%'; });
  el.addEventListener('pointerdown', (e) => {
    if (!P()) return;
    el.setPointerCapture(e.pointerId); el.classList.add('drag');
    const move = (ev) => { const f = at(ev); el.style.setProperty('--p', f * 100 + '%'); ctrl.querySelector('.yt-t0').textContent = fmtTime(f * dur()); };
    const up = (ev) => { el.classList.remove('drag'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); P().seekTo(at(ev) * dur(), true); };
    move(e); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
}
function syncButtons() {
  if (!ctrl) return;
  const playing = S.state === 1 || S.state === 3;
  for (const b of [...ctrl.querySelectorAll('[data-a=play]'), ...host.querySelectorAll('.yt-mini [data-a=play]')]) b.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
  ctrl.querySelector('[data-a=mute] use').setAttribute('href', S.muted || S.vol === 0 ? '#i-vol-x' : '#i-vol');
  const vol = ctrl.querySelector('.yt-vol input'); vol.value = S.muted ? 0 : S.vol; vol.style.setProperty('--p', (S.muted ? 0 : S.vol) + '%');
  ctrl.querySelector('.yt-rate span').textContent = S.rate === 1 ? '1×' : S.rate + '×';
  const q = qOf(S.quality), act = qLabel(S.actualQ);
  ctrl.querySelector('.yt-q span').textContent = q.id === 'auto' ? (act ? act : $t('Авто')) : q.label;
  const tag = ctrl.querySelector('.yt-q .qtag');
  const shownH = q.id === 'auto' ? (qOf(S.actualQ).h || 0) : q.h;
  tag.textContent = shownH >= 2160 ? '4K' : shownH >= 1440 ? 'QHD' : shownH >= 720 ? 'HD' : '';
  ctrl.querySelector('.yt-q').title = q.id === 'auto' ? $t('Качество: авто') + (act ? $t(' (сейчас {0})', act) : '') : $t('Качество: {0}', q.label) + (act && act !== q.label ? $t(' · сейчас {0} — YouTube ограничил по скорости сети или у видео нет такого', act) : '');
  ctrl.querySelector('.yt-q').classList.toggle('low', q.id !== 'auto' && !!act && (qOf(S.actualQ).h || 9999) < q.h);
  ctrl.querySelector('.yt-auto').classList.toggle('on', S.auto);
  ctrl.querySelector('[data-a=prev]').disabled = S.qi <= 0 && !S.cur;
  ctrl.querySelector('[data-a=next]').disabled = !(S.qi >= 0 && S.qi < S.queue.length - 1);
  view.classList.toggle('is-playing', playing); host.classList.toggle('is-playing', playing);
  const badge = document.getElementById('ytBadge');
  if (badge) badge.innerHTML = !S.cur ? '' : playing ? '<span class="eq"><i></i><i></i><i></i></span>' : '❚❚';
}
function showInfo() {
  const c = S.cur || {};
  view.querySelector('.yt-title').textContent = c.title || $t('Загрузка…');
  view.querySelector('.yt-meta').innerHTML = [c.channel ? `<b>${esc(c.channel)}</b>` : '', c.views ? esc(c.views) : '', c.age ? esc(c.age) : ''].filter(Boolean).join(' · ');
  host.querySelector('.yt-mini-t').textContent = c.title || '';
}
/** colours from the thumbnail, scoped to the YouTube view and the player layer */
async function paint(id) {
  const data = await YS.thumbData(id);
  if (!data || !S.cur || S.cur.id !== id) return;
  const p = await Theme.paletteFromImage(data, 'yt:' + id);
  for (const el of [view, host]) { el.style.setProperty('--y-accent', p.accent.css); el.style.setProperty('--y-accent-ink', p.accentInk.css); el.style.setProperty('--y-glow', p.glow.css); }
}

// ================================================================ search, lists, history
async function submit(text) {
  const q = String(text || '').trim(); if (!q) return;
  const link = YS.parseLink(q);
  if (link) {
    input.value = '';
    if (link.list) { play({ id: link.id || '', title: '' }, { list: link.list, start: link.start }); return; }
    const item = { id: link.id, title: '', channel: '', thumb: YS.thumb(link.id) };
    S.queue = [item]; S.qi = 0; S.tab = 'next'; play(item, { start: link.start });
    return;
  }
  if (YS.mode() === 'off') { searchOffNote(); return; }
  S.q = q; S.results = []; S.cont = '';
  if (S.cur) { S.tab = 'results'; sideList.innerHTML = `<div class="yt-note"><div class="spinner"></div>${$t('Ищу…')}</div>`; renderTabs(); }
  else { grid.innerHTML = skeletonCards(12); emptyBox.innerHTML = ''; }
  try {
    const r = await YS.search(q);
    if (S.q !== q) return;
    S.results = r.items; S.cont = r.cont;
  } catch (e) {
    const msg = `<div class="yt-note err"><b>${$t('Поиск не удался')}</b><span>${esc(e.message)}</span></div>`;
    if (S.cur) sideList.innerHTML = msg; else grid.innerHTML = msg;
    return;
  }
  if (S.cur) renderSide(); else renderGrid();
}
async function loadMore() {
  if (S.loadingMore || !S.cont) return;
  S.loadingMore = true;
  const q = S.q;
  const r = await YS.more(S.cont).catch(() => ({ items: [], cont: '' }));
  S.loadingMore = false;
  if (S.q !== q) return;
  const seen = new Set(S.results.map((x) => x.id));
  S.results.push(...r.items.filter((x) => !seen.has(x.id))); S.cont = r.cont;
  if (S.cur) renderSide(); else renderGrid();
}
async function fillTitles(items) {
  for (const it of items.slice(0, 120)) {
    if (it.title) continue;
    const m = await YS.oembed(it.id);
    Object.assign(it, { title: m.title, channel: m.channel });
    if (S.tab === 'next') renderSideDebounced();
  }
}
function remember(it) {
  if (!it || !it.id) return;
  const hist = ls.get('history', []).filter((x) => x.id !== it.id);
  hist.unshift({ id: it.id, title: it.title || '', channel: it.channel || '', dur: it.dur || (dur() ? fmtTime(dur()) : ''), t: Date.now() });
  ls.set('history', hist.slice(0, 80));
  if (S.tab === 'history') renderSide();
}
const listOf = (src) => (src === 'results' ? S.results : src === 'history' ? ls.get('history', []) : S.queue);
function listClick(e) {
  const card = e.target.closest('[data-i]'); if (!card) return;
  const src = card.dataset.src, i = +card.dataset.i, list = listOf(src), it = list[i]; if (!it) return;
  if (e.target.closest('[data-q]')) {           // «add to queue»
    e.stopPropagation();
    S.queue.push({ ...it }); if (!S.cur) { S.qi = S.queue.length - 1; play(S.queue[S.qi]); }
    toast(`${$t('В очереди:')} ${esc(it.title || $t('видео'))}`, { img: YS.thumb(it.id, 'default'), ms: 2200 }); renderSide(); return;
  }
  if (e.target.closest('[data-x]') && src === 'next') { e.stopPropagation(); S.queue.splice(i, 1); if (i < S.qi) S.qi--; renderSide(); syncButtons(); return; }
  if (src === 'next') { S.qi = i; play(it); return; }
  // results / history: play it and make the list the queue
  S.queue = list.map((x) => ({ ...x })); S.qi = i; play(S.queue[i]);
  if (src === 'results' || !S.cur) S.tab = 'next';
}

// ---------------------------------------------------------------- rendering
const card = (it, i, src) => `
  <div class="yt-card" data-i="${i}" data-src="${src}">
    <div class="th"><img loading="lazy" alt="" src="${esc(it.thumb || YS.thumb(it.id))}">${it.live ? '<b class="live">LIVE</b>' : it.dur ? `<b class="dur num">${esc(it.dur)}</b>` : ''}
      <span class="hov">${icon('play', 28)}</span><button class="q" data-q title="${$t('В очередь')}">${icon('queue', 18)}</button></div>
    <div class="tt">${esc(it.title || '…')}</div>
    <div class="ch">${esc(it.channel || '')}</div>
    <div class="mt">${[it.views, it.age].filter(Boolean).map(esc).join(' · ')}</div>
  </div>`;
const skeletonCards = (n) => Array.from({ length: n }, () => '<div class="yt-card sk"><div class="th"></div><div class="tt"><i class="skeleton" style="width:90%"></i></div><div class="ch"><i class="skeleton" style="width:50%"></i></div></div>').join('');
function renderGrid() {
  emptyBox.innerHTML = S.results.length ? `<div class="yt-head"><div class="kicker">${$t('Результаты')}</div><h2>«${esc(S.q)}»</h2></div>` : '';
  grid.innerHTML = S.results.length ? S.results.map((it, i) => card(it, i, 'results')).join('') + (S.cont ? `<div class="yt-more"><button class="btn">${$t('Показать ещё')}</button></div>` : '')
    : `<div class="yt-note"><b>${$t('Ничего не нашлось')}</b><span>${$t('Попробуйте другие слова')}</span></div>`;
  grid.querySelector('.yt-more button')?.addEventListener('click', loadMore);
}
/* search is opt-in: a link always plays; finding videos needs the user's own YouTube Data API key
   (official) or the unofficial results-page search, both chosen in Settings → YouTube */
function searchOffNote() {
  const html = `<div class="yt-note"><b>${$t('Поиск YouTube выключен')}</b><button class="btn sm primary" data-go-settings>${icon('gear')}${$t('Настройки YouTube')}</button></div>`;
  if (S.cur) { S.tab = 'results'; sideList.innerHTML = html; renderTabs(); } else { grid.innerHTML = html; emptyBox.innerHTML = ''; }
  view.querySelector('[data-go-settings]')?.addEventListener('click', () => { router.go('settings'); setTimeout(() => document.querySelector('.st-link[data-sec=youtube]')?.click(), 120); });
}
function renderEmpty() {
  if (!emptyBox || S.cur || S.results.length) return;
  const hist = ls.get('history', []);
  emptyBox.innerHTML = `
    <div class="yt-hero">
      <div class="yt-hero-ic">${icon('yt', 40)}</div>
      <h2>${$t('YouTube в Gatefold')}</h2>
      <p>${$t('Вставьте ссылку: <b>Ctrl+V</b>')}</p>
    </div>
    ${hist.length ? `<div class="yt-head"><div class="kicker">${$t('Недавно смотрели')}</div></div>` : ''}`;
  grid.innerHTML = hist.slice(0, 18).map((it, i) => card({ ...it, thumb: YS.thumb(it.id) }, i, 'history')).join('');
}
function renderTabs() { view.querySelectorAll('.yt-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === S.tab)); }
const row = (it, i, src, cur) => `
  <div class="yt-row${cur ? ' cur' : ''}" data-i="${i}" data-src="${src}">
    <div class="th"><img loading="lazy" alt="" src="${esc(YS.thumb(it.id, 'mqdefault'))}">${it.dur ? `<b class="dur num">${esc(it.dur)}</b>` : ''}${cur ? '<span class="eq"><i></i><i></i><i></i></span>' : ''}</div>
    <div class="tx"><div class="tt">${esc(it.title || '…')}</div><div class="ch">${esc(it.channel || '')}</div></div>
    ${src === 'next' ? `<button class="icon-btn x" data-x title="${$t('Убрать из очереди')}">${icon('x', 14)}</button>` : `<button class="icon-btn x" data-q title="${$t('В очередь')}">${icon('queue', 15)}</button>`}
  </div>`;
function renderSide() {
  if (!sideList) return;
  renderTabs();
  const list = listOf(S.tab);
  if (S.tab === 'next') sideList.innerHTML = list.length ? list.map((it, i) => row(it, i, 'next', i === S.qi)).join('') : `<div class="yt-note"><b>${$t('Очередь пуста')}</b></div>`;
  else if (S.tab === 'results') sideList.innerHTML = list.length ? list.map((it, i) => row(it, i, 'results', S.cur && it.id === S.cur.id)).join('') + (S.cont ? `<div class="yt-more"><button class="btn sm">${$t('Показать ещё')}</button></div>` : '') : `<div class="yt-note"><b>${$t('Нет результатов')}</b></div>`;
  else sideList.innerHTML = list.length ? list.map((it, i) => row(it, i, 'history', S.cur && it.id === S.cur.id)).join('') + `<div class="yt-more"><button class="btn sm" data-clear>${$t('Очистить историю')}</button></div>` : `<div class="yt-note"><b>${$t('История пуста')}</b></div>`;
  sideList.querySelector('.yt-more button:not([data-clear])')?.addEventListener('click', loadMore);
  sideList.querySelector('[data-clear]')?.addEventListener('click', () => { ls.set('history', []); renderSide(); });
  syncButtons();
}
const renderSideDebounced = debounce(renderSide, 300);

// ================================================================ keys (only in the YouTube view or fullscreen video)
addEventListener('keydown', (e) => {
  if (!S.built || !(router.current === 'youtube' || S.full)) return;
  if (e.target.closest && e.target.closest('input, textarea, select')) return;
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  const k = e.key;
  if (k === '/') { e.preventDefault(); e.stopImmediatePropagation(); input.focus(); return; }
  if (!S.cur) return;
  const map = {
    ' ': toggle, k: toggle, 'л': toggle,
    ArrowLeft: () => P() && P().seekTo(Math.max(0, time() - 5), true), ArrowRight: () => P() && P().seekTo(time() + 5, true),
    j: () => P() && P().seekTo(Math.max(0, time() - 10), true), 'о': () => P() && P().seekTo(Math.max(0, time() - 10), true),
    l: () => P() && P().seekTo(time() + 10, true), 'д': () => P() && P().seekTo(time() + 10, true),
    ArrowUp: () => setVol(S.vol + 5), ArrowDown: () => setVol(S.vol - 5),
    m: () => setMuted(!S.muted), 'ь': () => setMuted(!S.muted),
    f: () => setFull(!S.full), 'а': () => setFull(!S.full),
    t: () => ctrl.querySelector('[data-a=theater]').click(), 'е': () => ctrl.querySelector('[data-a=theater]').click(),
    n: () => step(1), 'т': () => step(1), p: () => step(-1), 'з': () => step(-1),
    q: () => qualityMenu(ctrl.querySelector('.yt-q')), 'й': () => qualityMenu(ctrl.querySelector('.yt-q')),
    Escape: () => (S.full ? setFull(false) : S.theater ? ctrl.querySelector('[data-a=theater]').click() : router.back()),
  };
  const fn = map[k.length === 1 ? k.toLowerCase() : k];
  if (!fn || (e.shiftKey && (k === 'ArrowLeft' || k === 'ArrowRight'))) return;
  e.preventDefault(); e.stopImmediatePropagation(); fn();
}, true);

// preferences changed in Settings
addEventListener('aurora:yt-pref', () => {
  S.quality = ls.get('quality', 'auto');
  if (!S.built) return;
  applyQuality(); syncButtons();
  input.placeholder = YS.mode() === 'off' ? $t('Ссылка на видео или плейлист YouTube') : $t('Поиск на YouTube или ссылка на видео');
  if (!S.results.length) renderEmpty();
});

// foobar2000 started playing → the video yields
const fooStarts = () => { if (P() && (S.state === 1 || S.state === 3)) P().pauseVideo(); };
on('playback:starting', (d) => { if (!d || !d.paused) fooStarts(); });
on('playback:paused', (d) => { if (d && d.paused === false) fooStarts(); });

onRoute((v) => { if (S.built) { requestAnimationFrame(place); if (v === 'youtube') { renderSide(); input && !S.cur && setTimeout(() => input.focus(), 50); } } });

/** router entry */
export function open(arg) {
  build();
  requestAnimationFrame(place);
  if (arg && arg.link) submit(arg.link);
}
export const state = S;
