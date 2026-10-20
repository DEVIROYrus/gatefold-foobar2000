// mock-more.js — smart playlists (getGenres, createAutoplaylist, counts), radio (Deezer related
// artists, per-artist track queries, a radio playlist), clear/rename.
(() => {
  if (window.__emptyMusic) return;
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const M = window.__more = { auto: [], radio: null };
  const rec = (m, p) => window.__calls.push([m, JSON.stringify(p)]);
  window.fb2k.invoke = async (m, p = {}) => {
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
