/*
 * Gatefold · lyrics.js — synced lyrics: find, parse, cache, render.
 *
 * Sources, first that gives SYNCED text wins:
 *   1. the track itself — lyrics.get (5 known tags, then .lrc/.txt beside the file;
 *      the same files Lyric Show Panel 3 reads)
 *   2. Gatefold's cache (IndexedDB)
 *   3. online providers in parallel (lyrics-sources.js): LRCLIB, Musixmatch, NetEase,
 *      QQ Music, Kugou — the best match wins, the other variants stay selectable
 * then the best UNSYNCED text from the same places.
 *
 * Downloaded lyrics stay in Gatefold's cache unless the user chose to save them
 * (.lrc beside the track or a LYRICS tag) — writing into the music folders is
 * opt-in after the cover-art incident.
 *
 * Rendering: the line list moves with one compositor transform; the current
 * line is found by binary search each frame (no DOM work unless it changes).
 * Enhanced LRC (<mm:ss.xx> word stamps) lights words up one by one.
 */
import { call, ok, log, esc } from './bridge.js';
import { settings } from './settings.js';
import * as IDB from './idb.js';
import * as SRC from './lyrics-sources.js';

import { $t } from './i18n.js';
export const events = new EventTarget();
const lc = (s) => String(s || '').toLowerCase().trim();
export const trackKey = (t) => `${lc(t.artist)}\u0001${lc(t.title)}\u0001${Math.round(t.duration || 0)}`;

// ================================================================ parsing
const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const sec = (m, s, f) => +m * 60 + +s + (f ? +f / 10 ** f.length : 0);

/** → { synced, lines:[{t, text, words?:[{t,w}]}], meta, offset } */
export function parseLRC(text) {
  const meta = {}; let offset = 0;
  const lines = [];
  const plain = [];
  for (const raw0 of String(text || '').replace(/﻿/g, '').split(/\r?\n/)) {
    const raw = raw0.trimEnd();
    const tag = raw.match(/^\[([a-z#]+):\s*(.*)\]\s*$/i);
    if (tag && !/^\d+$/.test(tag[1])) { const k = tag[1].toLowerCase(); meta[k] = tag[2]; if (k === 'offset') offset = (parseInt(tag[2], 10) || 0) / 1000; continue; }
    STAMP.lastIndex = 0;
    const stamps = []; let m, end = 0;
    while ((m = STAMP.exec(raw)) && m.index === end) { stamps.push(sec(m[1], m[2], m[3])); end = STAMP.lastIndex; }
    let body = raw.slice(end);
    if (!stamps.length) { if (raw.trim()) plain.push(raw.trim()); continue; }
    let words = null;
    if (WORD.test(body)) {
      WORD.lastIndex = 0;
      words = [];
      const parts = body.split(WORD); // [pre, m, s, f, text, m, s, f, text …]
      if (parts[0].trim()) words.push({ t: stamps[0], w: parts[0] });
      for (let i = 1; i + 3 < parts.length + 1; i += 4) { const w = parts[i + 3] ?? ''; if (w !== '') words.push({ t: sec(parts[i], parts[i + 1], parts[i + 2]), w }); }
      body = words.map((x) => x.w).join('');
      if (!words.length) words = null;
    }
    for (const t of stamps) lines.push({ t: Math.max(0, t - offset), text: body.trim(), words: words && words.map((x) => ({ t: Math.max(0, x.t - offset + (t - stamps[0])), w: x.w })) });
  }
  if (lines.length >= 2) {
    lines.sort((a, b) => a.t - b.t);
    // collapse consecutive empty lines; keep one as an instrumental gap
    const out = [];
    for (const l of lines) { if (!l.text && out.length && !out[out.length - 1].text) continue; out.push(l); }
    while (out.length && !out[out.length - 1].text) out.pop();
    return { synced: true, lines: out, meta, offset };
  }
  const textLines = String(text || '').split(/\r?\n/).map((s) => s.replace(STAMP, '').trim());
  return { synced: false, lines: textLines.map((s) => ({ t: -1, text: s })), meta, offset };
}

// ================================================================ fetching
const DAY = 864e5;
const enc = encodeURIComponent;
const cleanTitle = (s) => String(s || '')
  .replace(/\s*[([][^)\]]*\b(remaster(ed)?|mono|stereo|bonus|explicit|deluxe|single version|album version|radio edit)\b[^)\]]*[)\]]/gi, '')
  .replace(/\s+-\s+(\d{4}\s+)?(remaster(ed)?|mono|stereo)(\s+\d{4})?(\s+version)?\s*$/i, '')
  .trim();

async function fromTrack(t, type) {
  const path = t.handle || t.path;
  if (!path) return null;
  let r = await call('lyrics.get', { path, type });
  if (!ok(r) && (r.code === 'UNKNOWN_METHOD' || r.code === 'METHOD_NOT_FOUND' || /unknown|not found/i.test(r.error || ''))) r = await call('artwork.getLyrics', { path });
  if (!ok(r) || r.available === false || !r.lyrics) return null;
  const doc = parseLRC(r.lyrics);
  if (type === 'synced' && !doc.synced) return null;
  return { ...doc, text: r.lyrics, source: r.source === 'file' ? 'file' : 'embedded', sourcePath: r.sourcePath || '', tag: r.tagName || r.tag || '' };
}

const inflight = new Map();
/**
 * Best lyrics for a track. → doc { synced, lines, text, source, … } | { instrumental:true } | null
 * opts.online=false skips LRCLIB; opts.refresh=true ignores Gatefold's cache.
 */
export function getLyrics(t, opts = {}) {
  if (!t || !t.title) return Promise.resolve(null);
  const k = trackKey(t) + (opts.refresh ? '#r' : '');
  if (inflight.has(k)) return inflight.get(k);
  const p = (async () => {
    try {
      const local = await fromTrack(t, 'synced');
      if (local) return local;
      const online = opts.online ?? settings.lyricsOnline;
      let cached = opts.refresh ? null : await IDB.kvGet(CK(t));
      if (cached && cached.s === 'nf' && Date.now() - cached.t > 7 * DAY) cached = null;
      if (!cached && !opts.refresh) {                       // a text LRCLIB found before 1.9: reuse it, no new requests
        const old = await IDB.kvGet('lyr:' + trackKey(t));
        if (old && old.s === 'ok' && (old.synced || old.plain || old.instrumental)) cached = { s: 'ok', t: old.t, pick: 0, alts: [{ src: 'lrclib', synced: old.synced || '', plain: old.plain || '', instrumental: !!old.instrumental, words: /<\d+:\d+/.test(old.synced || '') }] };
      }
      if (!cached && online) {
        const res = await SRC.searchAll(t, settings.lyricsSources || {});
        cached = res.length
          ? { s: 'ok', t: Date.now(), pick: 0, alts: res.slice(0, 8).map((r) => ({ src: r.src, synced: r.synced || '', plain: r.plain || '', instrumental: !!r.instrumental, words: !!r.words, title: r.title || '', artist: r.artist || '' })) }
          : { s: 'nf', t: Date.now() };
        IDB.kvSet(CK(t), cached);
        const top = cached.alts && cached.alts[0];
        if (top && (top.synced || top.plain) && settings.lyricsSave !== 'none') saveToTrack(t, top.synced || top.plain).catch(() => {});
      }
      const alts = cached && cached.s === 'ok' ? cached.alts : [];
      const cur = alts[cached?.pick || 0] || alts[0];
      const meta = { alts: alts.map((a) => ({ src: a.src, synced: !!a.synced, words: !!a.words, instrumental: a.instrumental, plain: !!a.plain, title: a.title, artist: a.artist })), pick: cached?.pick || 0 };
      if (cur && cur.synced) return { ...parseLRC(cur.synced), text: cur.synced, source: cur.src, ...meta };
      const plainLocal = await fromTrack(t, 'any');
      if (plainLocal) return plainLocal;
      if (cur && cur.instrumental) return { instrumental: true, source: cur.src, lines: [], synced: false, ...meta };
      if (cur && cur.plain) return { ...parseLRC(cur.plain), text: cur.plain, source: cur.src, ...meta };
      return null;
    } catch (e) { log('lyrics failed', e); return null; }
    finally { setTimeout(() => inflight.delete(k), 1500); }
  })();
  inflight.set(k, p);
  return p;
}
const CK = (t) => 'lyr2:' + trackKey(t);
/** Use another found variant (another provider) for this track from now on. */
export async function choose(t, i) {
  const c = await IDB.kvGet(CK(t));
  if (!c || !c.alts || !c.alts[i]) return false;
  c.pick = i; await IDB.kvSet(CK(t), c);
  return true;
}

/** Write lyrics beside the track (.lrc) or into its tags. */
export async function saveToTrack(t, text, target = settings.lyricsSave === 'embedded' ? 'embedded' : 'file') {
  const doc = parseLRC(text);
  const r = await call('lyrics.save', { path: t.handle || t.path, lyrics: text, target: [target], ...(target === 'file' ? { format: doc.synced ? 'lrc' : 'txt' } : {}) });
  if (!ok(r)) throw new Error(r.error || r.code || $t('не удалось сохранить'));
  events.dispatchEvent(new CustomEvent('saved', { detail: { t, target, savedTo: r.savedTo || '' } }));
  return r;
}

// per-track timing correction (seconds; + = lyrics later)
const offsets = new Map();
export async function getOffset(t) { const k = trackKey(t); if (!offsets.has(k)) offsets.set(k, +(await IDB.kvGet('lyroff:' + k, 0)) || 0); return offsets.get(k); }
export function setOffset(t, v) { const k = trackKey(t); v = Math.round(v * 10) / 10; offsets.set(k, v); IDB.kvSet('lyroff:' + k, v); }

// ================================================================ view
/**
 * new LyricView(container, { getPos:()=>sec, seek:(sec)=>void, playing:()=>bool, variant:'panel'|'canvas' })
 * view.show(doc, track) · view.message(html) · view.setOffset(sec) · view.destroy()
 */

export class LyricView {
  constructor(el, o) {
    this.el = el; this.o = o; this.doc = null; this.cur = -2; this.word = -1; this.manualUntil = 0; this.manualY = 0; this.offset = 0; this.raf = 0; this.alive = true;
    el.classList.add('lyr', 'lyr-' + (o.variant || 'panel'));
    el.innerHTML = '<div class="lyr-track"></div>';
    this.track = el.firstChild;
    this.onWheel = (e) => {
      if (!this.doc || !this.doc.synced) return;
      e.preventDefault();
      if (performance.now() > this.manualUntil) this.manualY = this.currentY;
      this.manualY = Math.max(this.minY(), Math.min(this.maxY(), this.manualY - e.deltaY));
      this.manualUntil = performance.now() + 4000;
      this.place(this.manualY, true);
      clearTimeout(this.backT); this.backT = setTimeout(() => { this.cur = -2; this.tick(true); }, 4100);
    };
    el.addEventListener('wheel', this.onWheel, { passive: false });
    this.onClick = (e) => {
      const ln = e.target.closest('.ln'); if (!ln || !this.doc || !this.doc.synced) return;
      const l = this.doc.lines[+ln.dataset.i]; if (!l) return;
      this.manualUntil = 0; this.o.seek(Math.max(0, l.t + this.offset - 0.05));
    };
    el.addEventListener('click', this.onClick);
    this.ro = new ResizeObserver(() => { this.cur = -2; this.tick(true); });
    this.ro.observe(el);
    this.loop = this.loop.bind(this);
  }
  message(html) { this.doc = null; this.stop(); this.track.style.transform = ''; this.track.innerHTML = `<div class="lyr-msg">${html}</div>`; }
  show(doc, offset = 0) {
    this.doc = doc; this.offset = offset; this.cur = -2; this.word = -1; this.manualUntil = 0;
    if (!doc) { this.message($t('Текста нет')); return; }
    if (doc.instrumental) { this.message(`<b>${$t('♪ Инструментал')}</b>`); return; }
    if (!doc.synced) {
      this.track.style.transform = '';
      this.el.classList.add('plain');
      this.track.innerHTML = doc.lines.map((l) => `<div class="ln plain">${esc(l.text) || '&nbsp;'}</div>`).join('');
      this.stop(); return;
    }
    this.el.classList.remove('plain');
    this.track.innerHTML = doc.lines.map((l, i) => {
      if (!l.text) return `<div class="ln gap" data-i="${i}"><i></i><i></i><i></i></div>`;
      const inner = l.words ? l.words.map((w, j) => `<span data-w="${j}">${esc(w.w)}</span>`).join('') : esc(l.text);
      return `<div class="ln" data-i="${i}">${inner}</div>`;
    }).join('');
    this.nodes = [...this.track.children];
    this.tick(true);
    this.start();
  }
  setOffset(v) { this.offset = v; this.cur = -2; this.tick(true); }
  start() { if (!this.raf && this.alive) this.raf = requestAnimationFrame(this.loop); }
  stop() { if (this.raf) cancelAnimationFrame(this.raf); this.raf = 0; }
  loop() { this.raf = 0; if (!this.alive) return; this.tick(false); if (this.o.playing() && document.visibilityState === 'visible') this.start(); }
  /** Called by the owner on play/seek/visibility changes. */
  kick() { if (!this.doc || !this.doc.synced) return; if (performance.now() > this.manualUntil) this.tick(true); this.start(); }

  index(pos) {
    const L = this.doc.lines; let lo = 0, hi = L.length - 1, ans = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (L[mid].t <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
  }
  tick(force) {
    if (!this.doc || !this.doc.synced || !this.nodes) return;
    const pos = this.o.getPos() - this.offset + 0.12; // tiny lead: text should appear as the syllable starts
    const i = this.index(pos);
    if (i !== this.cur || force) {
      const prev = this.cur;
      this.cur = i;
      const n = this.nodes;
      if (prev >= 0 && n[prev]) { n[prev].classList.remove('cur'); n[prev].querySelectorAll('span.on').forEach((s) => s.classList.remove('on')); }
      if (force) n.forEach((el, k) => { el.classList.toggle('past', k < i); el.classList.toggle('cur', k === i); el.classList.toggle('near', Math.abs(k - i) === 1); });
      else {
        for (let k = Math.max(0, Math.min(prev, i) - 1); k <= Math.min(n.length - 1, Math.max(prev, i) + 1); k++) {
          n[k].classList.toggle('past', k < i); n[k].classList.toggle('cur', k === i); n[k].classList.toggle('near', Math.abs(k - i) === 1);
        }
      }
      this.word = -1;
      if (performance.now() > this.manualUntil) this.place(this.targetY(i), !force);
    }
    const l = i >= 0 && this.doc.lines[i];
    if (l && l.words) {
      let w = -1; for (let j = 0; j < l.words.length; j++) if (l.words[j].t <= pos) w = j; else break;
      if (w !== this.word) {
        const spans = this.nodes[i].children;
        for (let j = 0; j < spans.length; j++) spans[j].classList.toggle('on', j <= w);
        this.word = w;
      }
    }
  }
  anchor() { return this.el.clientHeight * (this.o.variant === 'canvas' ? 0.42 : 0.36); }
  targetY(i) {
    const el = this.nodes[Math.max(0, i)];
    if (!el) return 0;
    return Math.round(this.anchor() - (el.offsetTop + el.offsetHeight / 2));
  }
  minY() { const last = this.nodes[this.nodes.length - 1]; return last ? this.anchor() - (last.offsetTop + last.offsetHeight) : 0; }
  maxY() { return this.anchor(); }
  place(y, animate) {
    this.currentY = y;
    this.track.style.transition = animate ? '' : 'none';
    this.track.style.transform = `translate3d(0,${y}px,0)`;
    if (!animate) { void this.track.offsetHeight; this.track.style.transition = ''; }
  }
  destroy() { this.alive = false; this.stop(); this.ro.disconnect(); this.el.removeEventListener('wheel', this.onWheel); this.el.removeEventListener('click', this.onClick); clearTimeout(this.backT); }
}

export const sourceLabel = (doc) => !doc ? '' : SRC.PROVIDERS.some((p) => p.id === doc.source) ? SRC.nameOf(doc.source) : doc.source === 'file' ? $t('файл ') + (String(doc.sourcePath || '').split(/[\\/]/).pop() || '.lrc') : $t('теги файла') + (doc.tag ? ' · ' + doc.tag : '');
