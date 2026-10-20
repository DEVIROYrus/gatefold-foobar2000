// mock-ml.js — sound analysis: the whole library through library.query 'ALL', and the playlists
// made from the analysis («Similar tracks», mood and style playlists).
(() => {
  if (window.__emptyMusic) return;
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const ML = window.__ml = { created: [] };
  window.fb2k.invoke = async (m, p = {}) => {
    if (m === 'library.query' && (p.query === 'ALL' || p.query === '%path% PRESENT')) {
      const all = (await base('playlist.getTracks', { start: 0, count: 100000 })).tracks;
      return ok({ total: all.length, tracks: all.map((t) => ({ ...t, handle: t.absolutePath })) });
    }
    if (m === 'playlist.create' && !/^(Радио|Radio): |^(Понравившиеся|Liked)$/.test(p.name)) {
      const g = '{ML' + (ML.created.length + 1) + '}'; ML.created.push({ guid: g, name: p.name, handles: [] });
      return ok({ index: 20 + ML.created.length, guid: g });
    }
    if (m === 'playlist.addHandles' && /^\{ML\d+\}$/.test(p.playlistGuid)) { ML.created.find((x) => x.guid === p.playlistGuid).handles.push(...p.handles); return ok({ playlistGuid: p.playlistGuid }); }
    return base(m, p);
  };
})();
