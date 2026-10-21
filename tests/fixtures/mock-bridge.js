// Mock of the foo_ui_webview2 `fb2k` bridge for headless rendering tests.
(() => {
  const P = new URLSearchParams(location.search);
  const COVERS = { neon: '/covers/neon.jpg', desert: '/covers/desert.jpg', forest: '/covers/forest.jpg', paper: '/covers/paper.jpg', ocean: '/covers/ocean.jpg', small_neon: '/covers/small_neon.jpg', small_forest: '/covers/small_forest.jpg', crushed_desert: '/covers/crushed_desert.jpg' };
  const BIG = { small_neon: '/covers/big_neon.jpg', small_forest: '/covers/big_paper.jpg', crushed_desert: '/covers/big_desert.jpg' };
  const ALBUMS = [
    ['Nightdrive', 'Lumen Arcade', 'neon', 2021, 'Synthwave'],
    ['Sand & Signal', 'Mirage Theory', 'desert', 2019, 'Ambient'],
    ['Under Canopy', 'Fern Assembly', 'forest', 2022, 'Post-rock'],
    ['Белый лист', 'Тихий Час', 'paper', 2018, 'Indie'],
    ['Tidal Lines', 'Blue Hours', 'ocean', 2020, 'Electronic'],
    ['Без обложки', 'Неизвестный Бэнд', null, 2015, 'Rock'],
  ];
  const lib = [];
  for (let i = 0, NA = +P.get('big') || 66; i < NA; i++) { const b = ALBUMS[i % ALBUMS.length]; lib.push({ name: i < 6 ? b[0] : `${b[0]} ${['II', 'Live', 'Remixes', 'Sessions', 'EP', 'Demos', 'Vol. 3', 'B-Sides', 'Redux', 'Acoustic', 'Night', 'Day'][Math.floor(i / 6) % 12]}${i >= 72 ? ' ' + i : ''}`, albumArtist: i >= 72 ? b[1] + ' ' + (i % 97) : b[1], artist: b[1], cover: b[2], year: String(b[3] + (i % 4)), genre: b[4], trackCount: 8 + (i % 6), duration: 2400 + i * 37, firstTrackAbsolutePath: `D:\\Music\\${b[1]}\\${i}\\01.flac` }); }
  // quality fixtures: low-res / crushed covers whose big versions exist (neon, desert) or don't match (forest→paper)
  lib[6].cover = 'small_neon'; lib[8].cover = 'small_forest'; lib[7].cover = 'crushed_desert';
  if (P.get('perf')) lib.forEach((a, i) => { if (i % 3 === 1 && i > 9) a.cover = ''; });
  if (P.get('flat')) lib.forEach((a, i) => { if (i < 6) a.firstTrackAbsolutePath = `D:\\Music\\Flat\\${i}-01.flac`; });
  const titles = ['Afterglow', 'Static Bloom', 'Glass Harbor', 'Paper Moons', 'Kilometers', 'Long Exposure', 'Halcyon', 'Northbound', 'Слепое пятно', 'Velvet Engine', 'Low Tide', 'Signal Fire'];
  const PL_TRACKS = [];
  lib.slice(0, 14).forEach((a) => { for (let t = 0; t < a.trackCount; t++) PL_TRACKS.push({ title: titles[(t * 7 + a.name.length) % titles.length], artist: a.albumArtist, album: a.name, albumArtist: a.albumArtist, duration: 160 + ((t * 53 + a.name.length * 11) % 190), trackNumber: t + 1, discNumber: 1, date: a.year, codec: 'FLAC', absolutePath: a.firstTrackAbsolutePath.replace('01.flac', String(t + 1).padStart(2, '0') + '.flac'), subsong: 0, _cover: a.cover }); });
  const which = P.get('album') ? +P.get('album') : 0;
  let curIdx = PL_TRACKS.findIndex((t) => t.album === lib[which].name) + 2;
  const cur = () => ({ ...PL_TRACKS[curIdx], sampleRate: 96000, channels: 2, bitrate: 2834 });
  window.__calls = []; window.__saved = {}; window.__fs = {}; window.__written = {};
  window.__sidecar = window.__sidecar || {}; window.__embedded = {};
  const dirOf = (p) => String(p).replace(/[\\/][^\\/]*$/, '').toLowerCase();
  const coverOf = (path) => { if (window.__written[dirOf(path)]) return window.__written[dirOf(path)]; if (window.__sidecar[dirOf(path)]) return window.__sidecar[dirOf(path)].img; if (window.__embedded[path]) return window.__embedded[path]; return coverOf0(path); };
  const coverOf0 = (path) => { if (window.__saved[path] || Object.keys(window.__saved).some((k) => path.startsWith(k))) return '/covers/ocean.jpg'; const t = PL_TRACKS.find((x) => x.absolutePath === path) || lib.find((a) => a.firstTrackAbsolutePath === path); return t && (t._cover || t.cover) ? COVERS[t._cover || t.cover] : ''; };
  const handlers = {};
  const emit = (ev, d) => (handlers[ev] || []).forEach((f) => f(d));
  window.__emit = emit;
  window.__track = (i) => { curIdx = i; return cur(); };
  window.__setAlbum = (i) => { curIdx = PL_TRACKS.findIndex((t) => t.album === lib[i].name); emit('playback:trackChanged', cur()); };
  let specTimer = 0, t0 = performance.now();
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const api = {
    'window.getMode': () => ok({ mode: 'standalone', panelMode: false }),
    'window.getState': () => ok({ isMaximized: false, isMinimized: false, isFullscreen: false }),
    'playback.getCurrentTrack': () => ok({ found: true, track: cur() }),
    'playback.getState': () => ok({ state: 'playing' }),
    'playback.getPosition': () => ok({ position: 83, duration: cur().duration }),
    'playback.getVolume': () => ok({ volume: 72, isMuted: false }),
    'playback.getPlaybackOrder': () => ok({ orderIndex: 0 }),
    'playback.getStopAfterCurrent': () => ok({ enabled: false }),
    'playback.getCurrentTrackIndex': () => ok({ found: true, playlist: 0, index: curIdx }),
    'artwork.getFb2kUrl': () => { const u = coverOf(cur().absolutePath); return ok({ available: !!u, dataUrl: u }); },
    'artwork.getCurrent': () => { const u = coverOf(cur().absolutePath); return ok({ available: !!u, dataUrl: u }); },
    'artwork.getForTrack': async (p) => { window.__calls.push(['artwork.getForTrack', p.path]); const u = coverOf(p.path); if (!u) return ok({ available: false }); const b = new Uint8Array(await (await fetch(u)).arrayBuffer()); let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return ok({ available: true, mimeType: 'image/jpeg', size: b.length, dataUrl: 'data:image/jpeg;base64,' + btoa(s) }); },
    'artwork.getFb2kUrlByPath': (p) => { if (P.get('fb2kurls') && !p.maxSize) return ok({ available: true, dataUrl: 'fb2k://artwork/?path=' + encodeURIComponent(p.path) + '&type=' + (p.type || 'front') }); const u = coverOf(p.path); return ok({ available: true, dataUrl: u || '/covers/none_' + encodeURIComponent(p.path) + '.jpg' }); },
    'artwork.getFb2kUrlByPathBatch': (p) => ok({ artworks: (p.paths || (p.items || []).map((it) => it.path)).map((x) => { if (P.get('fb2kurls') && !p.maxSize) return { path: x, available: true, dataUrl: 'fb2k://artwork/?path=' + encodeURIComponent(x) + '&type=front' }; const u = coverOf(x); return { path: x, available: true, dataUrl: u || '/covers/none_' + encodeURIComponent(x) + '.jpg' }; }) }),
    'artwork.getAvailableArtwork': (p) => { const u = window.__written[dirOf(p.path)] || window.__embedded[p.path] || coverOf0(p.path); return ok({ available: !!u, artworks: u ? [{ type: 'front', source: 'folder:cover.jpg' }] : [], sources: u ? ['folder:cover.jpg'] : [] }); },
    'artwork.getFolderImages': (p) => { const sc = window.__sidecar[p.directory.toLowerCase()]; return ok({ images: sc ? [{ name: 'cover.jpg', path: p.directory + '\\cover.jpg', size: 50000 }] : [] }); },
    'file.delete': (p) => { window.__calls.push(['file.delete', p.path, 'trash=' + p.moveToTrash]); delete window.__sidecar[dirOf(p.path)]; if (/cover\.(jpg|png)$/i.test(p.path)) delete window.__written[dirOf(p.path)]; delete window.__fs[p.path]; return ok({}); },
    'file.mkdir': () => ok({ created: false }),
    'file.getInfo': (p) => /cover\.jpg$/i.test(p.path) ? ok({ exists: true, isFile: true, modified: (window.__sidecar[dirOf(p.path)] || {}).t || 0, name: 'cover.jpg' }) : ok({ exists: true, isDirectory: true, name: 'artists', parent: 'C:\\Users\\me\\AppData\\Roaming\\foobar2000-v2\\aurora' }),
    'file.list': (p) => ok({ files: Object.keys(window.__fs).filter((k) => k.startsWith(p.path + '\\')).map((k) => k.slice(p.path.length + 1)), directories: [] }),
    'file.read': (p) => window.__fs[p.path] ? ok({ content: window.__fs[p.path], encoding: 'base64' }) : Promise.resolve({ success: false, code: 'NOT_FOUND' }),
    'file.write': (p) => { window.__calls.push(['file.write', p.path, p.content.length]); const b64 = p.content.replace(/^base64:/, ''); window.__fs[p.path] = b64;
      if (/^D:\\Music.*\\cover\.(jpg|png)$/i.test(p.path)) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); window.__written[dirOf(p.path)] = URL.createObjectURL(new Blob([u], { type: 'image/jpeg' })); }
      return ok({ bytesWritten: p.content.length }); },
    'lyrics.get': (p) => {
      window.__calls.push(['lyrics.get', p.path, p.type]);
      if (/\\Lumen Arcade\\0\\/.test(p.path || '')) { const L = []; for (let t = 0; t < 240; t += 5) L.push(`[${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}.00]Локальная строка ${t / 5 + 1} из файла .lrc`); return ok({ available: true, lyrics: L.join('\n'), synced: true, source: 'file', sourcePath: p.path.replace(/\.flac$/, '.lrc') }); }
      return ok({ available: false, path: p.path });
    },
    'lyrics.save': (p) => { window.__calls.push(['lyrics.save', p.path, JSON.stringify(p.target), p.format || '', p.lyrics.length]); return ok({ savedTo: p.path.replace(/\.flac$/, '.lrc') }); },
    'shell.showInExplorer': (p) => { window.__calls.push(['shell.showInExplorer', p.path]); return ok({}); },
    'playback.setPosition': (p) => { window.__calls.push(['playback.setPosition', p.position]); return ok({}); },
    'window.createPopup': (p) => { window.__calls.push(['window.createPopup', p.url, p.frame, p.width + 'x' + p.height]); return ok({ windowId: 'popup-1' }); },
    'window.getAllWindows': () => ok({ windows: [{ windowId: 'main' }] }),
    'window.setFullscreen': (p) => { window.__calls.push(['window.setFullscreen', p.enabled]); return ok({ fullscreen: !!p.enabled }); },
    'window.getBounds': () => ok({ x: 100, y: 80, width: 1280, height: 760 }),
    'dnd.getPathsAsync': () => ok({ paths: ['E:\\Incoming\\Faith No More - Angel Dust (1992)'], resolvedPaths: [null], source: 'external' }),
    'playlist.create': (p) => { window.__calls.push(['playlist.create', p.name]); return ok({ index: 4, guid: '{E}' }); },
    'playlist.addPaths': (p) => { window.__calls.push(['playlist.addPaths', JSON.stringify(p.paths), p.playlistGuid]); return ok({ playlist: 4, playlistGuid: p.playlistGuid, addedCount: 12, countBefore: 0, totalCount: 12 }); },
    'menu.getContextMenu': (p) => { window.__calls.push(['menu.getContextMenu', p.mode, (p.handles || []).length + ' handles']); return ok({ items: [
      { type: 'submenu', label: 'Utils', children: [{ type: 'command', label: 'File Integrity Verifier', commandId: 11 }] },
      { type: 'submenu', label: 'Convert', children: [{ type: 'command', label: '...', commandId: 20 }, { type: 'command', label: 'Quick convert', commandId: 21 }, { type: 'separator' }, { type: 'command', label: 'FLAC → MP3 V0', commandId: 22 }, { type: 'command', label: 'FLAC → Opus 192', commandId: 23 }] },
      { type: 'submenu', label: 'ReplayGain', children: [{ type: 'command', label: 'Scan as albums', commandId: 30 }] },
      { type: 'command', label: 'Properties', commandId: 40 } ] }); },
    'menu.runContextCommandById': (p) => { window.__calls.push(['menu.runContextCommandById', p.id, p.mode, (p.handles || []).length + ' handles']); return ok({}); },
    'titleformat.eval': (p) => { if (String(p.pattern).startsWith('%codec%|')) return ok({ result: 'FLAC|24|96000|2834|12|Electronic|2020' }); if (!String(p.pattern).includes('\u0001')) return ok({ result: '24|Lossless|12|1|7' }); const c = cur(); const tot = PL_TRACKS.filter((x) => x.album === c.album).length;
      return ok({ result: [String(window.__plays ?? 7), '2025-11-02 21:14:00', c.genre || 'Ambient', c.date, '24', '96000', 'FLAC', '12', String(c.duration), String(c.trackNumber), String(tot), c.title, '2834', '2'].join('\u0001') }); },
    'audio.generateFullWaveform': () => { const n = 1600, w = []; for (let i = 0; i < n; i++) w.push(Math.abs(Math.sin(i / 37) * 0.6 + Math.sin(i / 5.3) * 0.25 + (Math.random() - 0.5) * 0.25) * (0.4 + 0.6 * Math.sin(i / n * Math.PI))); return ok({ status: 'ready', waveform: w }); },
    'audio.subscribeSpectrum': () => { clearInterval(specTimer); specTimer = setInterval(() => { const t = (performance.now() - t0) / 1000, s = []; const kick = Math.max(0, Math.sin(t * Math.PI * 2 * 2.05)) ** 8; for (let i = 0; i < 56; i++) s.push(Math.max(0, (1 - i / 60) * (0.45 + 0.25 * Math.sin(t * 3 + i * 0.4)) + (i < 6 ? kick * 0.5 : 0) + Math.random() * 0.08)); emit('audio:spectrum', { spectrum: s }); }, 16); return ok({}); },
    'audio.unsubscribeSpectrum': () => { clearInterval(specTimer); return ok({}); },
    'playlist.getAll': () => ok({ playlists: [{ index: 0, guid: '{A}', name: 'Вечерняя ротация', trackCount: PL_TRACKS.length, isActive: true, isPlaying: true }, { index: 1, guid: '{B}', name: 'Aurora', trackCount: 12 }, { index: 2, guid: '{C}', name: 'Lossless 24-bit', trackCount: 340, isAutoplaylist: true }, { index: 3, guid: '{D}', name: 'Road trip', trackCount: 58 }] }),
    'playlist.getActive': () => ok({ found: true, index: 0, guid: '{A}', name: 'Вечерняя ротация', trackCount: PL_TRACKS.length, duration: PL_TRACKS.reduce((s, t) => s + t.duration, 0) }),
    'playlist.getGroupRuns': () => { const runs = []; PL_TRACKS.forEach((t, i) => { const k = t.albumArtist + ' | ' + t.album; if (!runs.length || runs[runs.length - 1].key !== k) runs.push({ start: i, count: 0, key: k }); runs[runs.length - 1].count++; }); return ok({ runs, total: PL_TRACKS.length }); },
    'playlist.getTracks': (p) => ok({ tracks: PL_TRACKS.slice(p.start || 0, (p.start || 0) + (p.count || 100)).map((t, i) => ({ ...t, index: (p.start || 0) + i })), total: PL_TRACKS.length }),
    'library.getAlbums': (p) => { const q = (p.query || '').toLowerCase(); const l = lib.filter((a) => !q || a.name.toLowerCase().includes(q)); return ok({ albums: l.slice(p.offset || 0, (p.offset || 0) + (p.limit || 100)), total: l.length, hasMore: (p.offset || 0) + (p.limit || 100) < l.length }); },
    'playcount.getBatch': (p) => ok({ count: p.paths.length, results: p.paths.map((x) => { const pi = PL_TRACKS.findIndex((t) => t.absolutePath === x); if (pi >= 0) return { path: x, success: true, playCount: (pi * 7) % 23 + 1, lastPlayed: new Date(Date.UTC(2026, 8, 1) + pi * 36e5 * 7).toISOString().slice(0, 19).replace('T', ' '), added: '2024-02-02 10:00:00' }; const i = lib.findIndex((a) => a.firstTrackAbsolutePath === x); const d = new Date(Date.UTC(2026, 0, 1) + (i % 20) * 864e5 * 3); return { path: x, success: true, playCount: 0, added: i < 0 ? undefined : d.toISOString().slice(0, 19).replace('T', ' ') }; }) }),
    'library.query': (p) => { window.__calls.push(['library.query', p.query, p.sort]); if (/GREATER 0|DURING LAST \d+ DAYS/.test(p.query) && (p.fields || []).includes('absolutePath')) return ok({ total: PL_TRACKS.length, tracks: PL_TRACKS.map((t) => ({ ...t, genre: (lib.find((a) => a.name === t.album) || {}).genre })) }); const order = [3, 10, 1]; return ok({ total: 6, tracks: order.flatMap((i) => [{ album: lib[i].name, albumArtist: lib[i].albumArtist }, { album: lib[i].name, albumArtist: lib[i].albumArtist }]) }); },
    'audio.subscribeStream': (p) => {
      if (P.get('nostream')) return Promise.resolve({ success: false, code: 'NOT_SUPPORTED', error: 'stream unavailable' });
      window.__calls.push(['audio.subscribeStream', p.subscriptionId, p.interval]);
      const sr = 44100, ch = 2, cap = sr;
      const buf = new ArrayBuffer(64 + cap * ch * 4), u = new Uint32Array(buf, 0, 16), f = new Float32Array(buf);
      u[6] = cap; let ph = 0, written = 0, slot = 0, t = 0;
      clearInterval(window.__pcmT);
      window.__pcmT = setInterval(() => {
        const n = 706; u[7]++;
        for (let i = 0; i < n; i++) {
          t += 1 / sr;
          const env = 0.5 + 0.5 * Math.sin(t * 2 * Math.PI * 2);
          const v = 0.5 * env * Math.sin(2 * Math.PI * 60 * t) + 0.12 * Math.sin(2 * Math.PI * 440 * t) + 0.05 * Math.sin(2 * Math.PI * 3000 * t) + 0.01 * (Math.random() - 0.5);
          const v2 = v * (0.72 + 0.28 * Math.sin(t * 2 * Math.PI * 0.7)); f[16 + slot * ch] = v; f[16 + slot * ch + 1] = v2; slot = (slot + 1) % cap; written++;
        }
        u[8] = written >>> 0; u[15] = slot; u[7]++;
      }, 16);
      setTimeout(() => window.__webviewDispatch('sharedbufferreceived', { getBuffer: () => buf, additionalData: { purpose: 'audio.subscribeStream', subscriptionId: p.subscriptionId, epoch: 0, sampleRate: sr, channels: ch, capacityFrames: cap, headerBytes: 64 } }), 50);
      return Promise.resolve({ success: true, subscriptionId: p.subscriptionId, interval: p.interval, bufferSeconds: 1 });
    },
    'audio.unsubscribeStream': () => { clearInterval(window.__pcmT); window.__calls.push(['audio.unsubscribeStream']); return Promise.resolve({ success: true }); },
    'misc.showPreferences': () => { window.__calls.push(['misc.showPreferences']); return ok({}); },
    'menu.showNativePopup': (p) => { window.__calls.push(['menu.showNativePopup', JSON.stringify(p)]); return ok({}); },
    'menu.getMainMenu': () => ok({ items: [
      { type: 'submenu', label: 'File', children: [
        { type: 'command', label: 'Preferences', path: 'File/Preferences', executable: false },
        { type: 'command', label: 'Add folder...', path: 'File/Add folder...', guid: '{G-ADD}' } ] },
      { type: 'submenu', label: 'Edit', children: [ { type: 'command', label: 'Sort', path: 'Edit/Sort', executable: false } ] } ] }),
    'menu.runMainMenuCommand': (p) => {
      window.__calls.push(['menu.runMainMenuCommand', p.command]);
      if (p.command === 'Edit/Sort') return Promise.resolve({ success: false, code: 'MENU_MATCH_AMBIGUOUS', error: 'Command is ambiguous; address it by GUID instead: Edit/Sort', candidates: [{ name: 'Sort', displayLabel: 'Sort', guid: '{G-SORT}' }, { name: 'Sort by…', displayLabel: 'Sort', guid: '{G-OTHER}' }] });
      if (p.command === 'File/Preferences') return Promise.resolve({ success: false, code: 'MENU_MATCH_AMBIGUOUS', error: 'Command is ambiguous; address it by GUID instead: File/Preferences', candidates: [] });
      return ok({ guid: p.command });
    },
    'library.getAlbumTracks': (p) => ok({ tracks: PL_TRACKS.filter((t) => t.album === p.album).map((t, i) => ({ ...t, index: i, sampleRate: 96000, channels: 2, bitrate: 2700 + ((i * 37) % 300), fileSize: Math.round(t.duration * 345000) })) }),
    // album details: rich values for most albums, none at all for the albums of Mirage Theory (a bare album)
    'titleformat.evalFieldsBatch': (p) => ok({ total: p.paths.length, results: p.paths.map((path, i) => {
      const t = PL_TRACKS.find((x) => x.absolutePath === String(path).split('|')[0]) || {};
      if (/^M/.test(t.albumArtist || '')) return { path, success: true, infoAvailable: true, ...Object.fromEntries(Object.keys(p.fields).map((k) => [k, ''])) };
      const v = { bits: '24', prof: 'Lossless', enc: 'lossless', dr: String(8 + (i % 5)), adr: '10', tg: (-7.5 - (i % 4) * 0.8).toFixed(2) + ' dB', ag: '-8.20 dB', ap: '0.998',
        plays: String((i * 3) % 7), last: '2026-10-19 21:14:03', added: '2025-03-02 10:00:00', date: (t.date || '2020') + '-05-12', odate: '', label: 'Night Owl Records', cat: 'NOR-0' + (10 + i % 3), genre: 'Synthwave; Electronic' };
      return { path, success: true, infoAvailable: true, ...Object.fromEntries(Object.keys(p.fields).map((k) => [k, v[k] ?? ''])) };
    }) }),
    'library.search': () => ok({ tracks: PL_TRACKS.slice(0, 30), total: 30 }),
    'queue.get': () => ok({ items: PL_TRACKS.slice(20, 23) }),
    'http.get': async (p) => {
      window.__calls.push(['http.get', p.url, p.responseType || 'text']);
      if (/itunes\.apple\.com\/search/.test(p.url) && P.get('q2')) {
        const term = decodeURIComponent(p.url.split('term=')[1].split('&')[0]).toLowerCase();
        const hit = lib.filter((a) => term.includes(a.name.toLowerCase())).sort((a, b) => b.name.length - a.name.length)[0];
        return ok({ status: 200, body: JSON.stringify({ resultCount: hit ? 1 : 0, results: hit ? [{ collectionName: hit.name, artistName: hit.albumArtist, artworkUrl100: `https://is1-ssl.mzstatic.com/image/thumb/${hit.cover || 'none'}/100x100bb.jpg`, trackCount: hit.trackCount, releaseDate: hit.year + '-01-01T00:00:00Z' }] : [] }) });
      }
      if (/mzstatic/.test(p.url) && p.responseType === 'base64' && P.get('q2')) { const tok = p.url.split('/thumb/')[1].split('/')[0]; const f = BIG[tok] || '/covers/ocean.jpg'; const b = new Uint8Array(await (await fetch(f)).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return ok({ status: 200, body: btoa(s) }); }
      if (/lrclib\.net\/api\/get/.test(p.url)) {
        const q = new URLSearchParams(p.url.split('?')[1]);
        if (q.get('artist_name') === 'Mirage Theory') { const L = []; for (let t = 2; t < 300; t += 4) { const m = String(Math.floor(t / 60)).padStart(2, '0'), s2 = String(t % 60).padStart(2, '0'); L.push(t % 20 === 18 ? `[${m}:${s2}.00]` : t % 12 === 6 ? `[${m}:${s2}.00]<${m}:${s2}.00>Каждое <${m}:${s2}.80>слово <${m}:${String(t % 60 + 1).padStart(2, '0')}.60>по <${m}:${String(t % 60 + 2).padStart(2, '0')}.40>очереди` : `[${m}:${s2}.00]${q.get('track_name')} — строка ${Math.round(t / 4)} с LRCLIB`); } return ok({ status: 200, body: JSON.stringify({ id: 42, trackName: q.get('track_name'), artistName: 'Mirage Theory', syncedLyrics: L.join('\n'), plainLyrics: 'plain', instrumental: false }) }); }
        return ok({ status: 404, body: JSON.stringify({ code: 404, name: 'TrackNotFound' }) });
      }
      if (/lrclib\.net\/api\/search/.test(p.url)) return ok({ status: 200, body: '[]' });
      if (/itunes\.apple\.com\/search/.test(p.url)) return ok({ status: 200, body: JSON.stringify({ resultCount: 2, results: [
        { collectionName: 'Другой альбом', artistName: 'Кто-то ещё', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/bb/source/100x100bb.jpg', trackCount: 3 },
        { collectionName: 'Без обложки (Remastered)', artistName: 'Неизвестный Бэнд', artworkUrl100: 'https://is1-ssl.mzstatic.com/image/thumb/Music/v4/aa/source/100x100bb.jpg', trackCount: 8, releaseDate: '2015-03-01T08:00:00Z' }] }) });
      if (/mzstatic/.test(p.url) && p.responseType === 'base64') { const b = new Uint8Array(await (await fetch('/covers/ocean.jpg')).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return ok({ status: 200, body: btoa(s) }); }
      if (/api\.deezer\.com\/search\/artist/.test(p.url)) {
        const q = decodeURIComponent(p.url.split('q=')[1].split('&')[0]);
        const same = [{ id: 1, name: q, nb_fan: 52000, picture_xl: 'https://cdn-images.dzcdn.net/images/artist/wrong/1000x1000.jpg' },
                      { id: 2, name: q, nb_fan: 3100, picture_xl: 'https://cdn-images.dzcdn.net/images/artist/right' + encodeURIComponent(q) + '/1000x1000.jpg' }];
        return ok({ status: 200, body: JSON.stringify({ data: q === 'Тихий Час' ? [] : same }) });
      }
      if (/api\.deezer\.com\/artist\/1\/albums/.test(p.url)) return ok({ status: 200, body: JSON.stringify({ data: [{ title: 'Totally Different Record' }, { title: 'Another One' }] }) });
      if (/api\.deezer\.com\/artist\/2\/albums/.test(p.url)) return ok({ status: 200, body: JSON.stringify({ data: lib.map((a) => ({ title: a.name })) }) });
      if (/dzcdn\.net\/images\/artist/.test(p.url) && p.responseType === 'base64') {
        const f = /wrong/.test(p.url) ? '/covers/paper.jpg' : ['/covers/forest.jpg', '/covers/desert.jpg', '/covers/neon.jpg', '/covers/ocean.jpg'][p.url.length % 4];
        const b = new Uint8Array(await (await fetch(f)).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return ok({ status: 200, body: btoa(s) });
      }
      return ok({ status: 200, body: '{}' });
    },
    'metadata.embedArtwork': (p) => {
      // quality fixtures: low-res / crushed covers whose big versions exist (neon, desert) or don't match (forest→paper)
  lib[6].cover = 'small_neon'; lib[8].cover = 'small_forest'; lib[7].cover = 'crushed_desert';
  if (P.get('flat')) {
        window.__calls.push(['metadata.embedArtwork', p.path, JSON.stringify(p.target), p.imageData.length + ' b64']);
        if ((p.target || []).includes('file') || (p.target || []).includes('all')) { window.__sidecar[dirOf(p.path)] = { img: '/covers/ocean.jpg', t: Date.now() }; return ok({ savedTo: p.path.replace(/[^\\]+$/, 'cover.jpg') }); }
        window.__embedded[p.path] = '/covers/ocean.jpg'; return ok({});
      } window.__calls.push(['metadata.embedArtwork', p.path, JSON.stringify(p.target), p.type, p.imageData.length + ' b64 chars']); window.__saved[p.path.replace(/[^\\]+$/, '')] = 1; return ok({ savedTo: p.path.replace(/[^\\]+$/, 'cover.jpg') }); },
    'artwork.getLyrics': () => ok({ available: true, lyrics: '[00:10.00]Мы смотрим на огни ночного города\n[00:16.00]И каждый светофор как метроном\n[00:22.00]Afterglow, afterglow\n[00:30.00]Ты держишь руль, я держу паузу\n[00:38.00]Пока не кончится этот трек', synced: true }),
  };
  if (!P.get('nowebview')) {
    const L = {};
    window.chrome = window.chrome || {};
    window.chrome.webview = { addEventListener: (ev, fn) => (L[ev] = L[ev] || []).push(fn), removeEventListener() {}, postMessage() {} };
    window.__webviewDispatch = (ev, e) => (L[ev] || []).forEach((fn) => fn(e));
  }
  window.fb2k = {
    invoke(m, p) { return (api[m] ? api[m](p || {}) : ok({})); },
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); },
  };
})();
