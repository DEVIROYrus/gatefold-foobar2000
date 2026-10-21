// mock-showcase.js — the outermost mock layer for the README screenshots and the demo: a real music
// library (Creative-Commons albums, tools/showcase/albums.json) instead of the test fixtures.
// window.__SHOW = { catalog, http, mode }  — catalog.json from build.py; http = recorded responses
// (MusicBrainz, by URL); mode 'record' (CI: real network through /proxy, real
// audio through /pcm) or 'replay' (local: recorded answers only).
(() => {
  const S = window.__SHOW; if (!S) return;
  const C = S.catalog, base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const T = C.tracks.map((t, i) => ({ ...t, subsong: 0, discNumber: 1, handle: t.absolutePath, index: i }));
  const byPath = new Map(T.map((t) => [t.absolutePath, t]));
  const albumOf = (t) => C.albums.find((a) => a.album === t.album && a.artist === t.albumArtist);
  const coverOf = (path) => { const t = byPath.get(path) || T.find((x) => x.absolutePath.startsWith(String(path).replace(/[^\\]*$/, ''))); const a = t && albumOf(t); return a ? '/showcase/' + a.cover : ''; };
  // the playing queue: «Late night» = a few albums in a row
  const PL = (S.playlist || C.albums.slice(0, 6).map((a) => a.album)).flatMap((name) => T.filter((t) => t.album === name));
  let cur = Math.max(0, PL.findIndex((t) => t.title === S.start)) || 0;
  const track = () => ({ ...PL[cur], index: cur });
  window.__setAlbum = (i) => { const a = typeof i === 'number' ? C.albums[i] : C.albums.find((x) => x.album === i); if (!a) return; const j = PL.findIndex((t) => t.album === a.album); if (j >= 0) cur = j + (S.offset || 0); else { PL.unshift(...T.filter((t) => t.album === a.album)); cur = 0; } window.__emit('playback:trackChanged', track()); };
  window.__setTrack = (title) => { const j = PL.findIndex((t) => t.title === title); if (j >= 0) { cur = j; window.__emit('playback:trackChanged', track()); } };
  const b64of = async (u) => { const b = new Uint8Array(await (await fetch(u)).arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };
  const albums = C.albums.map((a) => { const ts = T.filter((t) => t.album === a.album && t.albumArtist === a.artist); return { name: a.album, albumArtist: a.artist, artist: a.artist, year: a.year, genre: a.genre || '', trackCount: ts.length, duration: ts.reduce((s, t) => s + t.duration, 0), firstTrackAbsolutePath: ts[0].absolutePath }; });
  const lossless = (t) => /flac|alac|wav|ape|wavpack/i.test(t.codec);
  const match = (q) => {   // the few foobar2000 queries the smart-playlist sheet asks for
    q = String(q || '');
    if (/^ALL$|%path% PRESENT/.test(q)) return T;
    let r = T;
    const dec = q.match(/%date% GREATER (\d{4}) AND %date% LESS (\d{4})/); if (dec) r = r.filter((t) => +String(t.date).slice(0, 4) > +dec[1] && +String(t.date).slice(0, 4) < +dec[2]);
    if (/%__encoding% IS lossless/.test(q)) r = r.filter(lossless);
    if (/%samplerate% GREATER 48000 OR %__bitspersample% GREATER 16/.test(q)) r = r.filter((t) => t.bitsPerSample > 16 || t.sampleRate > 48000);
    const len = q.match(/%length_seconds% GREATER (\d+)/); if (len) r = r.filter((t) => t.duration > +len[1]);
    const g = q.match(/genre IS "?([^"]+)"?/); if (g) r = r.filter((t) => (t.genre || '').toLowerCase() === g[1].toLowerCase());
    const aa = q.match(/"album artist" IS "([^"]+)"/); if (aa) r = r.filter((t) => t.albumArtist === aa[1]);
    if (/play_count|added|last_played|rating/.test(q)) r = [];
    return r;
  };
  const rec = S.http || {};
  const replay = (url) => {
    if (rec[url]) return rec[url];
    return null;
  };
  const pcm = async (p) => {   // CI only: real audio, decoded by ffmpeg on the build server
    const sr = p.sampleRate || 16000;
    const r = await fetch(`/pcm?path=${encodeURIComponent(p.path)}&start=${p.start || 0}&end=${p.end || 0}&sr=${sr}`);
    const raw = new Float32Array(await r.arrayBuffer()), n = raw.length;
    const buf = new ArrayBuffer(64 + n * 4); new DataView(buf).setUint32(24, n, true); new DataView(buf).setUint32(32, n, true);
    new Float32Array(buf, 64, n).set(raw);
    const taskId = 'pcm_s' + (pcm.n = (pcm.n || 0) + 1);
    setTimeout(() => { window.__webviewDispatch('sharedbufferreceived', { getBuffer: () => buf, additionalData: { purpose: 'audio.decodePcm', taskId, sampleRate: sr, channels: 1, frames: n, headerBytes: 64 } }); window.__emit('audio:pcmReady', { taskId, frames: n }); }, 5);
    return ok({ taskId, status: 'pending' });
  };
  const api = {
    'playback.getCurrentTrack': () => ok({ found: true, track: track() }),
    'playback.getPosition': () => ok({ position: Math.round(track().duration * 0.38), duration: track().duration }),
    'playback.getCurrentTrackIndex': () => ok({ found: true, playlist: 0, index: cur }),
    'artwork.getFb2kUrl': () => { const u = coverOf(track().absolutePath); return ok({ available: !!u, dataUrl: u }); },
    'artwork.getCurrent': () => { const u = coverOf(track().absolutePath); return ok({ available: !!u, dataUrl: u }); },
    'artwork.getForTrack': async (p) => { const u = coverOf(p.path); if (!u) return ok({ available: false }); const s = await b64of(u); return ok({ available: true, mimeType: 'image/jpeg', size: s.length, dataUrl: 'data:image/jpeg;base64,' + btoa(s) }); },
    'artwork.getFb2kUrlByPath': (p) => { const u = coverOf(p.path); return ok({ available: !!u, dataUrl: u }); },
    'artwork.getFb2kUrlByPathBatch': (p) => ok({ artworks: (p.paths || (p.items || []).map((it) => it.path)).map((x) => { const u = coverOf(x); return { path: x, available: !!u, dataUrl: u }; }) }),
    'artwork.getAvailableArtwork': (p) => { const u = coverOf(p.path); return ok({ available: !!u, artworks: u ? [{ type: 'front', source: 'embedded' }] : [], sources: u ? ['embedded'] : [] }); },
    'artwork.getFolderImages': () => ok({ images: [] }),
    'titleformat.eval': (p) => {
      const t = track();
      if (String(p.pattern).startsWith('%__bitspersample%|%codec_profile%')) return ok({ result: [t.bitsPerSample || '', t.profile || '', '', t.rg ? '1' : '', ''].join('|') });
      return base('titleformat.eval', p);
    },
    'audio.generateFullWaveform': (p) => { const t = byPath.get(p.path) || track(); const w = (S.waves || {})[t.absolutePath]; return ok({ status: 'ready', waveform: w ? w.map((v) => v / 100) : [] }); },
    'playlist.getAll': () => ok({ playlists: [{ index: 0, guid: '{A}', name: S.playlistName || 'Late night', trackCount: PL.length, isActive: true, isPlaying: true }, { index: 1, guid: '{B}', name: 'Road trip', trackCount: 58 }, { index: 2, guid: '{C}', name: 'Lossless', trackCount: T.filter(lossless).length, isAutoplaylist: true }, { index: 3, guid: '{D}', name: 'Sunday morning', trackCount: 24 }] }),
    'playlist.getActive': () => ok({ found: true, index: 0, guid: '{A}', name: S.playlistName || 'Late night', trackCount: PL.length, duration: PL.reduce((s, t) => s + t.duration, 0) }),
    'playlist.getGroupRuns': () => { const runs = []; PL.forEach((t, i) => { const k = t.albumArtist + ' | ' + t.album; if (!runs.length || runs[runs.length - 1].key !== k) runs.push({ start: i, count: 0, key: k }); runs[runs.length - 1].count++; }); return ok({ runs, total: PL.length }); },
    'playlist.getTracks': (p) => { if (p.playlistGuid && p.playlistGuid !== '{A}') return base('playlist.getTracks', p); return ok({ tracks: PL.slice(p.start || 0, (p.start || 0) + (p.count || 100)).map((t, i) => ({ ...t, index: (p.start || 0) + i })), total: PL.length }); },
    'library.getAlbums': (p) => { const q = (p.query || '').toLowerCase(); const l = albums.filter((a) => !q || (a.name + ' ' + a.albumArtist).toLowerCase().includes(q)); return ok({ albums: l.slice(p.offset || 0, (p.offset || 0) + (p.limit || 100)), total: l.length, hasMore: false }); },
    'library.getAlbumTracks': (p) => ok({ tracks: T.filter((t) => t.album === p.album && (!p.albumArtist || t.albumArtist === p.albumArtist)) }),
    'library.search': (p) => { const q = String(p.query || p.text || '').toLowerCase(); const r = T.filter((t) => !q || (t.title + ' ' + t.artist + ' ' + t.album).toLowerCase().includes(q)); return ok({ tracks: r.slice(0, 50), total: r.length }); },
    'library.query': (p) => { const r = match(p.query); return ok({ total: r.length, tracks: r.slice(0, p.limit > 0 ? p.limit : r.length) }); },
    'library.getGenres': () => { const c = new Map(); T.forEach((t) => t.genre && c.set(t.genre, (c.get(t.genre) || 0) + 1)); return ok({ genres: [...c].map(([name, trackCount]) => ({ name, trackCount })).sort((a, b) => b.trackCount - a.trackCount) }); },
    'playcount.getBatch': (p) => ok({ count: p.paths.length, results: p.paths.map((x) => ({ path: x, success: true, playCount: 0 })) }),
    'queue.get': () => ok({ items: [] }),
    'lyrics.get': (p) => ok({ available: false, path: p.path }),
    'artwork.getLyrics': () => ok({ available: false }),
    'audio.decodePcm': (p) => (S.mode === 'record' ? pcm(p) : ok({ success: false })),
    'http.get': async (p) => {
      const u = String(p.url);
      if (!/musicbrainz\.org/.test(u)) return ok({ status: 404, body: '' });
      if (S.mode === 'record') { const r = await (await fetch('/proxy?url=' + encodeURIComponent(u))).json(); return ok(r); }
      const r = replay(u); return ok(r || { status: 404, body: '' });
    },
  };
  window.fb2k.invoke = (m, p = {}) => (api[m] ? api[m](p) : base(m, p));
})();
