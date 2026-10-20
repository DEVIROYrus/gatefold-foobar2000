// mock-more.js — smart playlists (getGenres, createAutoplaylist, counts), radio (Deezer related
// artists, per-artist track queries, a radio playlist), clear/rename.
(() => {
  if (window.__emptyMusic) return;
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const M = window.__more = { auto: [], radio: null };
  const rec = (m, p) => window.__calls.push([m, JSON.stringify(p)]);
  window.fb2k.invoke = async (m, p = {}) => {
    if (m === 'audio.decodePcm') {
      // synthetic audio: Lumen Arcade and Mirage Theory slow and dark, Blue Hours and Fern Assembly fast and harsh
      const all = (await base('playlist.getTracks', { start: 0, count: 100000 })).tracks;
      const t = all.find((x) => x.absolutePath === String(p.path).split('|')[0]) || {};
      const harsh = /Blue Hours|Fern Assembly/.test(t.albumArtist || '');
      const SR = p.sampleRate || 11025, n = Math.round(SR * Math.max(1, (p.end || 12) - (p.start || 0)));
      const buf = new ArrayBuffer(64 + n * 4); new DataView(buf).setUint32(24, n, true); new DataView(buf).setUint32(32, n, true);
      const x = new Float32Array(buf, 64, n); let sd = (p.start || 1) * 7919 + 13; const rnd = () => (sd = (sd * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < n; i++) {
        const tt = i / SR;
        if (harsh) { const g = ((tt * 190 / 60 * 4) % 1) < 0.6 ? 1 : 0.2; x[i] = Math.tanh(8 * (Math.sin(2 * Math.PI * 146 * tt) + 0.5 * Math.sin(2 * Math.PI * 293 * tt))) * 0.35 * g + (((tt * 190 / 60) % 1) < 0.05 ? (rnd() - 0.5) * 0.9 : 0) + (rnd() - 0.5) * 0.15 * g; }
        else { const b = tt % 1; x[i] = Math.tanh(4 * Math.sin(2 * Math.PI * 82 * tt)) * 0.25 * (0.7 + 0.3 * Math.sin(2 * Math.PI * tt / 4)) + 0.04 * (rnd() - 0.5) + (b < 0.1 ? 0.4 * Math.sin(2 * Math.PI * 50 * tt) * (1 - b / 0.1) : 0); }
      }
      const taskId = 'pcm_' + (M.pcm = (M.pcm || 0) + 1);
      setTimeout(() => { window.__webviewDispatch('sharedbufferreceived', { getBuffer: () => buf, additionalData: { purpose: 'audio.decodePcm', taskId, sampleRate: SR, channels: 1, frames: n, headerBytes: 64 } }); window.__emit('audio:pcmReady', { taskId, frames: n }); }, 5);
      return ok({ taskId, status: 'pending' });
    }
    if (m === 'library.getAlbums' && !(p.offset > 0) && !p.query) {
      // two different albums with one title in one flat folder (they must stay two albums)
      const r = await base(m, p);
      r.albums = [...r.albums,
        { name: 'Eternity', albumArtist: 'Anathema', artist: 'Anathema', year: '1996', genre: 'Doom Metal', trackCount: 13, duration: 3700, firstTrackAbsolutePath: 'D:\\Opus\\Anathema - Sentient.opus' },
        { name: 'Eternity', albumArtist: 'Kamelot', artist: 'Kamelot', year: '2001', genre: 'Power Metal', trackCount: 13, duration: 3800, firstTrackAbsolutePath: 'D:\\Opus\\Kamelot - Eternity.opus' },
        { name: 'Paradise', albumArtist: 'Someone', artist: 'Someone', year: '2010', genre: 'Rock', trackCount: 9, duration: 2000, firstTrackAbsolutePath: 'D:\\Opus\\Someone - Paradise.opus' }];
      return r;
    }
    if (m === 'library.getGenres') return ok({ genres: [{ name: 'Synthwave', trackCount: 120 }, { name: 'Ambient', trackCount: 80 }, { name: 'Post-rock', trackCount: 40 }] });
    if (m === 'playlist.createAutoplaylist') { rec(m, p); M.auto.push(p); return ok({ index: 9, playlist: 9, guid: '{AUTO' + M.auto.length + '}', name: p.name, query: p.query }); }
    if (m === 'library.query' && p.limit === 0) { rec('count', p); return ok({ total: /play_count|added/.test(p.query) ? 0 : 137, tracks: [] }); }
    if (m === 'library.query' && /"album artist" IS/.test(p.query)) {
      const name = p.query.match(/"album artist" IS "([^"]+)"/)[1];
      const all = (await base('playlist.getTracks', { start: 0, count: 100000 })).tracks;
      return ok({ total: 0, tracks: all.filter((t) => t.albumArtist === name).map((t) => ({ ...t, handle: t.absolutePath })) });
    }
    if (m === 'http.get' && /api\.deezer\.com\/artist\/\d+\/related/.test(p.url)) return ok({ status: 200, body: JSON.stringify({ data: ['Mirage Theory', 'Unknown Elsewhere', 'Blue Hours', 'Fern Assembly'].map((name, i) => ({ id: 100 + i, name })) }) });
    if (m === 'playlist.create' && /^(Радио|Radio): /.test(p.name)) { rec(m, p); M.radio = { guid: '{RADIO}', name: p.name, handles: [] }; return ok({ index: 8, guid: '{RADIO}' }); }
    if (m === 'playlist.addHandles' && p.playlistGuid === '{RADIO}') { rec('radio.add', { n: p.handles.length }); M.radio.handles.push(...p.handles); return ok({ playlistGuid: '{RADIO}' }); }
    if (m === 'playlist.getTrackCount' && p.playlistGuid === '{RADIO}') return ok({ count: M.radio.handles.length });
    return base(m, p);
  };
})();
