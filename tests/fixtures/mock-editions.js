// mock-editions.js — (only with window.__eds) one title in two releases, and albums by several artists:
//   · The Struts — Everybody Wants: 2014 (4 songs) and the 2016 Deluxe reissue (2 of them + 2 new), two folders
//   · Long Way — two CD sub-folders of one release (must stay one album)
//   · Duets by «Alpha; Beta» (one tag value), Twin Sun by Gamma + Delta (a multi-value tag), Simon & Garfunkel
(() => {
  if (!window.__eds) return;
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const D = 'D:\\Music\\';
  const tr = (album, aa, dir, n, title, date, extra = {}) => ({ album, albumArtists: Array.isArray(aa) ? aa : [aa], artists: Array.isArray(aa) ? aa : [aa], title, date, discNumber: extra.disc || 1, trackNumber: n,
    duration: 200 + n, absolutePath: `${D}${dir}\\${String(n).padStart(2, '0')}.flac`, codec: 'FLAC' });
  const T = [
    ...['Put Your Money on Me', 'Could Have Been Me', 'Kiss This', 'Black Swan'].map((t, i) => tr('Everybody Wants', 'The Struts', 'The Struts\\2014 - Everybody Wants', i + 1, t, '2014')),
    ...['Put Your Money on Me', 'Could Have Been Me', 'Mary Go Round', 'The Ol\' Switcheroo'].map((t, i) => tr('Everybody Wants', 'The Struts', 'The Struts\\2016 - Everybody Wants (Deluxe Edition)', i + 1, t, '2016')),
    ...['One', 'Two'].map((t, i) => tr('Long Way', 'Kite Lines', 'Kite Lines\\Long Way\\CD1', i + 1, t, '2019')),
    ...['Three', 'Four'].map((t, i) => tr('Long Way', 'Kite Lines', 'Kite Lines\\Long Way\\CD2', i + 1, t, '2019', { disc: 2 })),
    ...['Hello', 'Again', 'Later', 'Bye'].map((t, i) => tr('Duets', 'Alpha; Beta', 'Alpha; Beta\\Duets', i + 1, t, '2021')),
    ...['Dawn', 'Noon', 'Dusk', 'Night'].map((t, i) => tr('Twin Sun', ['Gamma', 'Delta'], 'Gamma\\Twin Sun', i + 1, t, '2022')),
    ...['Bridge', 'Boxer', 'Cecilia'].map((t, i) => tr('Bridges', 'Simon & Garfunkel', 'Simon & Garfunkel\\Bridges', i + 1, t, '1970')),
  ];
  // window.__edsMany: 120 more «X & Y» names, more than the separators preview shows at once
  if (window.__edsMany) for (let n = 1; n <= 120; n++) T.push(tr('Pairs', 'Various Artists', 'Pairs', n, 'Song ' + n, '2020', {}));
  if (window.__edsMany) T.slice(-120).forEach((t, i) => { t.artists = [`Duo ${i + 1} & Pair ${i + 1}`]; });
  window.__edTracks = T;
  const row = (album, aa, list) => ({ name: album, albumArtist: aa, artist: aa, year: list[0].date, genre: 'Rock', trackCount: list.length, duration: list.reduce((n, t) => n + t.duration, 0), firstTrackAbsolutePath: list[0].absolutePath });
  const groups = new Map();
  for (const t of T) { const k = t.album + '\u0001' + t.albumArtists[0]; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
  const ROWS = [...groups.values()].map((l) => row(l[0].album, l[0].albumArtists[0], l));
  const handle = (t) => t.absolutePath;
  window.fb2k.invoke = async (m, p = {}) => {
    if (m === 'library.getAlbums' && !(p.offset > 0) && !p.query) { const r = await base(m, p); r.albums = [...r.albums, ...ROWS]; return r; }
    if (m === 'library.query' && p.query === 'ALL' && (p.fields || []).includes('albumArtists')) {
      const r = await base(m, p);
      return ok({ total: (r.tracks || []).length + T.length, tracks: [...(r.tracks || []), ...T.map((t) => { const o = {}; for (const f of p.fields) if (t[f] !== undefined) o[f] = t[f]; return o; })] });
    }
    if (m === 'library.getAlbumTracks') {
      const l = T.filter((t) => t.album === p.album && t.albumArtists[0] === p.albumArtist);
      if (l.length) return ok({ tracks: l.map((t, i) => ({ ...t, artist: t.artists.join(', '), albumArtist: t.albumArtists.join(', '), index: i, handle: handle(t), sampleRate: 44100, channels: 2, bitrate: 900 })) });
    }
    if (m === 'titleformat.evalFieldsBatch' && p.fields && 'ed' in p.fields) {
      window.__calls.push(['editions.tags', p.paths.length]);
      return ok({ total: p.paths.length, results: p.paths.map((path) => ({ path, success: true, ed: /Deluxe/.test(path) ? 'Deluxe' : '', mb: '' })) });
    }
    return base(m, p);
  };
})();
// theme files (Settings → Look → «Своя тема»: export / import), only with window.__themeIo
(() => {
  if (!window.__themeIo) return;
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const F = 'D:\\Themes\\gatefold-theme.json';
  window.__themeFiles = {};
  window.fb2k.invoke = async (m, p = {}) => {
    const json = (p.filters || []).some((f) => (f.extensions || []).includes('json'));
    if (m === 'dialog.saveFile' && json) return ok({ canceled: false, filePath: F });
    if (m === 'dialog.openFile' && json) return ok({ canceled: false, filePaths: [F] });
    if (m === 'file.write' && p.path === F) { window.__themeFiles[F] = p.content; return ok({ bytesWritten: p.content.length }); }
    if (m === 'file.read' && p.path === F) return window.__themeFiles[F] ? ok({ content: window.__themeFiles[F] }) : Promise.resolve({ success: false, code: 'NOT_FOUND', error: 'not found' });
    return base(m, p);
  };
})();
// DSP presets and chain for the «Звук» panel, only with window.__dsp
(() => {
  if (!window.__dsp) return;
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const S = window.__dspState = { presets: ['Headphones', 'Speakers', 'Night'], sel: -1, chain: [] };
  const chains = { Headphones: ['Equalizer', 'Crossfeed'], Speakers: ['Equalizer'], Night: ['Dynamic range compressor', 'Equalizer'] };
  window.fb2k.invoke = async (m, p = {}) => {
    if (m === 'dsp.getPresets') return ok({ presets: S.presets.map((name, index) => ({ index, name, active: index === S.sel })), count: S.presets.length, selectedIndex: S.sel });
    if (m === 'dsp.getChain') return ok({ dsps: S.chain.map((name, index) => ({ index, name, guid: '{D' + index + '}' })), activePreset: S.sel >= 0 ? S.presets[S.sel] : null, activePresetIndex: S.sel });
    if (m === 'dsp.applyPreset') {
      window.__calls.push(['dsp.applyPreset', p.index]);
      S.sel = p.index; S.chain = chains[S.presets[p.index]];
      setTimeout(() => window.__emit('audio:dspPresetChanged', {}), 20);
      return ok({ appliedPreset: S.presets[p.index], appliedIndex: p.index });
    }
    if (m === 'menu.getMainMenu') return ok({ items: [
      { type: 'submenu', label: 'View', children: [{ type: 'command', label: 'Equalizer', path: 'View/Equalizer', guid: '{G-EQ}' }] },
      { type: 'submenu', label: 'Playback', children: [{ type: 'submenu', label: 'DSP settings', children: [{ type: 'command', label: 'Preferences', path: 'Playback/DSP settings/Preferences', guid: '{G-DSPPREF}' }] }] }] });
    return base(m, p);
  };
})();
// a picture on «your computer» for the cover picker (900×1200, an LP sleeve), only with window.__pick
(() => {
  if (!window.__pick) return;
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const P = 'C:\\Pictures\\sleeve.jpg';
  window.fb2k.invoke = async (m, p = {}) => {
    if (m === 'dialog.openFile' && (p.filters || []).some((f) => (f.extensions || []).includes('jpg'))) { window.__calls.push(['dialog.openFile', p.title || '']); return ok({ canceled: false, filePaths: [P] }); }
    if (m === 'file.read' && p.path === P) {
      const b = new Uint8Array(await (await fetch('/covers/sleeve.jpg')).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x);
      return ok({ content: btoa(s), encoding: 'base64', size: b.length });
    }
    return base(m, p);
  };
})();
