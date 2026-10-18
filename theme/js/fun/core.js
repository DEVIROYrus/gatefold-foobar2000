/*
 * Gatefold · fun/core.js — «Режим приколов»: interface skins + achievements.
 *
 * Contract:
 *   - nothing in js/fun/ is loaded while the mode is off (the only always-present
 *     piece is the 1 KB js/skin-boot.js that applies a chosen skin before first paint);
 *   - every part gets a scoped runtime (timers, listeners, DOM, classes) that is
 *     disposed completely on stop;
 *   - the mode never writes tags, files, playlists or the library and makes no sound;
 *   - its data lives only under localStorage "aurora.fun.*" and IndexedDB "fun.*"
 *     and is erased when the mode is switched off.
 */
import { call, ok, on, log, normTrack, albumKeyOf } from '../bridge.js';
import { settings, setSetting } from '../settings.js';
import { toast as uiToast, router } from '../ui.js';
import * as App from '../app.js';
import * as IDB from '../idb.js';

import { $t } from '../i18n.js';
export const LS = 'aurora.fun.';
const bus = new EventTarget();
export const emit = (type, detail) => bus.dispatchEvent(new CustomEvent(type, { detail }));

// ---------------------------------------------------------------- storage (namespaced, wiped on disable)
const cache = new Map(), pendingSaves = new Set();
let storeAlive = true;     // false after the mode was switched off: late saves must not resurrect data
export function store(name, dflt = {}) {
  if (cache.has(name)) return cache.get(name);
  let v; try { v = JSON.parse(localStorage.getItem(LS + name) || 'null'); } catch { v = null; }
  const obj = v && typeof v === 'object' ? { ...dflt, ...v } : { ...dflt };
  let t = 0;
  const write = () => { if (storeAlive) try { localStorage.setItem(LS + name, JSON.stringify(obj)); } catch {} };
  Object.defineProperty(obj, 'save', { enumerable: false, value: (now = false) => {
    if (!storeAlive) return;
    clearTimeout(t);
    if (now) { write(); return; }
    pendingSaves.add(() => clearTimeout(t));
    t = setTimeout(write, 300);
  } });
  cache.set(name, obj);
  return obj;
}
async function wipe() {
  storeAlive = false;
  for (const c of pendingSaves) c(); pendingSaves.clear();
  const keys = [];
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(LS)) keys.push(k); }
  keys.forEach((k) => localStorage.removeItem(k));
  cache.clear();
  await IDB.kvDelPrefix('fun.');
  return keys.length;
}
export const cfg = () => store('cfg', { ach: true });

// ---------------------------------------------------------------- DOM helpers
let layer = null, cssLink = null;
function mountLayer() {
  if (!cssLink) {
    cssLink = document.createElement('link');
    cssLink.rel = 'stylesheet'; cssLink.href = new URL('../../css/fun.css', import.meta.url).href; cssLink.id = 'funCss';
    document.head.appendChild(cssLink);
  }
  if (!layer) { layer = document.createElement('div'); layer.id = 'funLayer'; document.body.appendChild(layer); }
}
function unmountLayer() { layer?.remove(); layer = null; cssLink?.remove(); cssLink = null; }
export const html = (s) => { const t = document.createElement('template'); t.innerHTML = s.trim(); return t.content.firstElementChild; };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const getLayer = () => layer;

// ---------------------------------------------------------------- scoped runtime
export function runtime(id) {
  const disposers = [];
  let dead = false;   // an async start() may resume after a stop: whatever it registers then is undone at once
  const add = (f) => { if (dead) { try { f(); } catch {} return f; } disposers.push(f); return f; };
  return {
    id,
    on: (ev, fn) => add(on(ev, fn)),
    sub: (ev, fn) => { bus.addEventListener(ev, fn); add(() => bus.removeEventListener(ev, fn)); },
    listen: (t, ev, fn, o) => { t.addEventListener(ev, fn, o); add(() => t.removeEventListener(ev, fn, o)); },
    every: (ms, fn) => { const h = setInterval(fn, ms); add(() => clearInterval(h)); return h; },
    after: (ms, fn) => { const h = setTimeout(fn, ms); add(() => clearTimeout(h)); return h; },
    el: (markup, parent) => { const e = typeof markup === 'string' ? html(markup) : markup; (parent || layer).appendChild(e); add(() => e.remove()); return e; },
    cleanup: add,
    alive: () => !dead,
    dispose: () => { dead = true; while (disposers.length) { try { disposers.pop()(); } catch (e) { console.warn('[fun] dispose', id, e); } } },
  };
}

// ---------------------------------------------------------------- playback context (for achievements)
const TF = ['%play_count%', '%last_played%', '%genre%', '%date%', '%__bitspersample%', '%samplerate%', '%codec%',
  '$if2(%album dynamic range%,%dynamic range%)', '%length_seconds%', '%tracknumber%', '%totaltracks%', '%title%', '%bitrate%', '%channels%'];
const KEYS = ['plays', 'lastPlayed', 'genre', 'date', 'bits', 'sr', 'codec', 'dr', 'len', 'no', 'total', 'title', 'bitrate', 'channels'];
export const now = { t: null, info: null, played: 0, resumed: 0, state: 'stopped', session: { tracks: 0, skips: [], sameRun: 0, lastKey: '', startedAt: Date.now() } };
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
export const tsOf = (s) => { if (!s || s === '?') return 0; const t = Date.parse(String(s).replace(' ', 'T')); return Number.isFinite(t) ? t : 0; };
async function loadInfo() {
  const r = await call('titleformat.eval', { pattern: TF.join('\u0001') });
  if (!ok(r)) return null;
  const v = String(r.result || '').split('\u0001');
  const o = {}; KEYS.forEach((k, i) => { o[k] = v[i] === '?' ? '' : (v[i] || ''); });
  for (const k of ['plays', 'bits', 'sr', 'dr', 'len', 'no', 'total', 'bitrate', 'channels']) o[k] = num(o[k]);
  const t = now.t || {};   // fall back to the bridge's track object when a field didn't evaluate
  if (!o.no) o.no = +t.trackNumber || 0; if (!o.len) o.len = +t.duration || 0;
  for (const k of ['title', 'date', 'codec', 'genre']) if (!o[k] && t[k]) o[k] = String(t[k]);
  o.year = +((o.date.match(/\d{4}/) || [0])[0]) || 0;
  o.lastPlayedTs = tsOf(o.lastPlayed);
  return o;
}
const playedNow = () => now.played + (now.state === 'playing' && now.resumed ? (performance.now() - now.resumed) / 1000 : 0);
const wires = [];
function wirePlayback() {
  if (wires.length) return;
  const onTrack = async (d) => {
    const t = normTrack(d); if (!t) return;
    const prev = now.t ? { t: now.t, info: now.info, played: playedNow() } : null;
    if (prev) {
      const len = prev.info?.len || prev.t.duration || 0;
      prev.completed = len > 0 && prev.played >= len - 6;
      prev.skipped = !prev.completed && prev.played < 5;
    }
    now.t = t; now.info = null; now.played = 0; now.resumed = now.state === 'playing' ? performance.now() : 0;
    const key = albumKeyOf(t.albumArtist, t.album) + '\u0001' + t.title;
    now.session.sameRun = key === now.session.lastKey ? now.session.sameRun + 1 : 1; now.session.lastKey = key;
    now.session.tracks++;
    if (prev && prev.skipped) { now.session.skips = [...now.session.skips, Date.now()].filter((x) => Date.now() - x < 120000); emit('skip', { prev }); }
    now.info = await loadInfo();
    if (!enabled) return;
    emit('track', { t, info: now.info, prev });
    if (prev && prev.completed && prev.info && prev.info.total && prev.info.no >= prev.info.total) emit('albumDone', { prev });
  };
  const onState = (st) => {
    if (st === now.state) return;
    if (now.state === 'playing' && now.resumed) now.played += (performance.now() - now.resumed) / 1000;
    now.state = st; now.resumed = st === 'playing' ? performance.now() : 0;
    emit('state', { state: st });
  };
  wires.push(on('playback:trackChanged', onTrack));
  wires.push(on('playback:paused', (d) => onState(d.paused ? 'paused' : 'playing')));
  wires.push(on('playback:starting', (d) => { if (!d.paused) onState('playing'); }));
  wires.push(on('playback:stopped', (d) => { if (!/another|starting/i.test(String(d.reason || ''))) onState('stopped'); }));
  wires.push(on('playback:seeked', (d) => emit('seek', d)));
  wires.push(on('playback:volumeChanged', (d) => emit('volume', d)));
  const p = App.player();
  now.state = p.state; now.resumed = p.state === 'playing' ? performance.now() : 0;
  if (p.track) { now.t = p.track; loadInfo().then((i) => { now.info = i; if (enabled) emit('track', { t: now.t, info: i, prev: null, initial: true }); }); }
}
export const playedSeconds = playedNow;

// ---------------------------------------------------------------- parts
let enabled = false, Skins = null, Ach = null;
export const isEnabled = () => enabled;

export async function enable({ quiet = false } = {}) {
  if (enabled) return;
  enabled = true; storeAlive = true;
  mountLayer();
  [Skins, Ach] = await Promise.all([import('./skins.js'), import('./achievements.js')]);
  if (!enabled) return;                                   // switched off while loading
  wirePlayback();
  await Skins.start();
  if (cfg().ach) Ach.start();
  log('fun mode on');
  if (!quiet) openPanel();
}
export async function disable() {
  if (!enabled) return;
  enabled = false;                                        // first: late async callbacks check it and bail out
  try { Ach?.stop(); } catch (e) { console.warn(e); }
  try { Skins?.stop(); } catch (e) { console.warn(e); }
  (await import('./panel.js').catch(() => null))?.close();
  while (wires.length) { try { wires.pop()(); } catch {} }
  now.t = null; now.info = null;
  await wipe();
  unmountLayer();
  document.querySelectorAll('.fun-modal-back,.fun-ach').forEach((e) => e.remove());
  uiToast($t('Режим выключен, его данные стёрты.'), { ms: 3500 });
}
export function setAchievements(onOff) {
  const c = cfg(); c.ach = !!onOff; c.save();
  if (!Ach) return;
  onOff ? Ach.start() : Ach.stop();
}

export async function openPanel() {
  if (!enabled) await enable({ quiet: true });
  (await import('./panel.js')).open();
}
export { router, setSetting, settings, uiToast as toast };
