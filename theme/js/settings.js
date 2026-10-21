/* Gatefold · settings.js — persistent settings (WebView2 profile localStorage) */
const KEY = 'aurora.settings.v1';

export const DEFAULTS = {
  // appearance
  updateCheck: true,       // look for a new Gatefold release on GitHub (at most every 12 h)
  taskbarButtons: true,    // ⏮ ⏯ ⏭ ♡ on the taskbar thumbnail (wininteg.js)
  taskbarProgress: true,   // playback progress drawn on the taskbar button
  trayIcon: false,         // an icon in the notification area with a player menu
  minimizeToTray: false,   // only with trayIcon
  closeToTray: false,      // only with trayIcon
  miniTopmost: true,       // the mini player stays above other windows (mini.js)
  language: 'auto',        // 'auto' (system) | 'ru' | 'en' — read by i18n.js before anything renders
  ytSearch: 'off',         // YouTube search: 'off' (links only) | 'api' (YouTube Data API v3, own key) | 'web' (unofficial, parses the results page)
  ytApiKey: '',
  colorSource: 'album',     // 'album' (colours of the playing cover) | fixed themes: 'dark' | 'light' | 'gray'
  themeMode: 'auto',        // 'auto' (follows cover lightness) | 'dark' | 'light'
  colorIntensity: 1,        // 0.4 … 1.5 — chroma multiplier for derived colours
  fontMode: 'hybrid',       // 'hybrid' (Segoe UI Variable text + Inter display) | 'inter' | 'system'
  baseSize: 14,             // integer px — integer sizes keep hinting on the pixel grid
  crispText: true,          // opaque list panels → ClearType-quality text
  ambient: true,            // cover-derived aurora background
  ambientMotion: true,      // slow drift of the aurora blobs (compositor-only)
  beatReact: true,          // cover breathes with the bass
  visualizer: true,         // spectrum on the Now Playing screen
  vuMeters: false,          // two VU meters instead of the spectrum (vu.js) — off unless turned on
  vuStyle: 'classic',       // 'classic' (ivory dial) | 'album' (the album's colours)
  vuCanvas: true,           // the meters in the Canvas too
  vuRef: -14,               // dBFS of a sine that reads 0 VU: -18 (studio) | -14 | -10 (loud masters)
  waveformSeek: true,       // waveform seek bar coloured by the palette
  transitionMs: 1100,       // palette crossfade duration
  frameless: true,          // draw own title bar (standalone mode only)
  backdrop: 'none',         // 'none' | 'mica' — window material behind the UI
  sidebarCollapsed: false,
  // behaviour
  albumTarget: 'dedicated', // 'dedicated' (playlist "Gatefold") | 'active'
  librarySort: 'artist',
  startView: 'now',
  // cover fetcher
  coverAuto: true,          // fetch for the playing album when it has no art
  coverSweep: true,         // background sweep over the whole library
  coverMinSize: 600,        // reject images smaller than this (px, shortest side)
  coverMaxSize: 3000,       // downscale anything larger (0 = keep original)
  coverTarget: 'file',      // 'file' (cover.jpg next to tracks) | 'all' (file + embed into first track)
  coverThreshold: 0.82,     // auto-accept score; below → review queue
  coverSources: { itunes: true, deezer: true, musicbrainz: true },
  coverCountries: 'US,RU',
  coverSharedDir: 'embed',  // folder shared by several albums: 'embed' into that album's tracks | 'skip'
  // artist photos
  artistAuto: true,         // download missing artist photos into %profile%\\aurora\\artists
  artistSort: 'name',
  // fun mode («экспериментальные функции»): its own data lives under aurora.fun.* and is wiped when off
  funMode: false,
  // cover quality
  qualityMinRes: 600,       // shortest side below this → "low resolution"
  qualityMinJpegQ: 55,      // estimated JPEG quality below this → "heavily compressed"
  qualityAuto: 'same',      // auto-replace only when the new image matches the old one visually: 'same' | 'never'
  // thumbnails
  thumbCache: true,         // persistent cover thumbnails (IndexedDB)
  thumbCacheMB: 400,
  // lyrics
  lyricsOnline: true,
  // LRCLIB is an open database; the others are reached through unofficial client APIs — off until the user opts in
  lyricsSources: { lrclib: true, musixmatch: false, netease: false, qq: false, kugou: false },       // LRCLIB when the track has no synced lyrics
  lyricsSave: 'none',       // what to do with downloaded lyrics: 'none' (Gatefold cache only) | 'file' (.lrc beside the track) | 'embedded'
  lyricsSize: 'm',          // 's' | 'm' | 'l'
  // canvas (fullscreen)
  canvasLayout: 'cover',    // 'cover' | 'lyrics' | 'minimal'
  canvasMotion: true,       // slow Ken Burns drift of the cover
  canvasLyrics: true,
  canvasClock: false,
  canvasIdleMin: 5,         // enter Canvas after N idle minutes while playing and focused (0 = off)
  soundAI: false,          // sound analysis with a neural network (ml/sound.js): models downloaded on request
  soundPaused: false,
  soundGenresOnline: true,  // genres of artists and albums from MusicBrainz (ml/genres.js), only with soundAI on
  soundSpeed: 'normal',     // 'gentle' | 'normal' | 'fast' | 'max' — how hard the analysis may work (ml/sound.js)
  motionFps: 'max',         // 'max': animations at the monitor's refresh rate | 'eco': spectrum ≤ 60 fps, background 12 fps
  plViewDefault: 'auto',   // playlist view when the playlist has none of its own: auto | albums | covers | grid | compact
  fullscreenTopmost: false, // true: fullscreen stays above every other window (the component's default)
};

let state = load();
const subs = new Set();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...raw, coverSources: { ...DEFAULTS.coverSources, ...(raw.coverSources || {}) }, lyricsSources: { ...DEFAULTS.lyricsSources, ...(raw.lyricsSources || {}) } };
  } catch { return { ...DEFAULTS }; }
}

export const settings = new Proxy({}, { get: (_, k) => state[k] });

export function setSetting(key, value) {
  if (state[key] === value) return;
  state = { ...state, [key]: value };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  for (const fn of subs) fn(key, value, state);
}

export function onSettings(fn) { subs.add(fn); return () => subs.delete(fn); }

/* Another Gatefold window (the Canvas popup) changed a setting → apply it here too. */
window.addEventListener('storage', (e) => {
  if (e.key !== KEY) return;
  const prev = state; state = load();
  for (const k of Object.keys(state)) if (JSON.stringify(prev[k]) !== JSON.stringify(state[k])) for (const fn of subs) fn(k, state[k], state);
});

export function resetSettings() {
  state = { ...DEFAULTS };
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  for (const fn of subs) fn('*', null, state);
}

const stores = new Set();
addEventListener('pagehide', () => { for (const st of stores) if (st._save) st.flush(); });

/** Small LRU-ish JSON store on localStorage, used for palette + cover caches. */
export class JsonStore {
  constructor(key, max = 800) { this.key = key; this.max = max; this.data = {}; this.order = [];
    try { const r = JSON.parse(localStorage.getItem(key) || '{}'); this.data = r.d || {}; this.order = r.o || Object.keys(this.data); } catch {}
    this._save = null;
  }
  get(k) { return this.data[k]; }
  set(k, v) {
    if (!(k in this.data)) this.order.push(k);
    this.data[k] = v;
    if (this.holes > 64) this.compact();
    while (this.order.length > this.max) delete this.data[this.order.shift()];
    this.persist();
  }
  delete(k) { if (!(k in this.data)) return; delete this.data[k]; this.holes = (this.holes || 0) + 1; this.persist(); } // order is compacted lazily: deleting in a loop stays O(n)
  /* localStorage is synchronous: serialising a 2000-entry store on every change
     during a scan stalled the page. Writes are coalesced (2 s), done in idle time,
     and flushed when the page goes away. */
  persist() {
    if (this._save) return;
    stores.add(this);
    this._save = setTimeout(() => {
      const run = () => this.flush();
      if (window.requestIdleCallback) requestIdleCallback(run, { timeout: 3000 }); else run();
    }, 2000);
  }
  compact() { const seen = new Set(); this.order = this.order.filter((x) => x in this.data && !seen.has(x) && seen.add(x)); this.holes = 0; }
  flush() {
    clearTimeout(this._save); this._save = null;
    if (this.holes) this.compact();
    try { localStorage.setItem(this.key, JSON.stringify({ d: this.data, o: this.order })); } catch {}
  }
}
