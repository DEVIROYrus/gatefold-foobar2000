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
// MusicBrainz: genres for some artists of the mock library; «Тихий Час» and «Неизвестный Бэнд» are unknown to it
(() => {
  if (window.__emptyMusic) return;
  const base = window.fb2k.invoke.bind(window.fb2k);
  const MB = { 'Lumen Arcade': ['synthwave', 'outrun'], 'Mirage Theory': ['dark ambient', 'synthwave'], 'Fern Assembly': ['post-rock', 'math rock'], 'Blue Hours': ['industrial', 'ebm'] };
  const ALB = { 'Lumen Arcade': 'Nightdrive', 'Mirage Theory': 'Sand & Signal', 'Fern Assembly': 'Under Canopy', 'Blue Hours': 'Tidal Lines' };
  const ok = (body) => Promise.resolve({ success: true, status: 200, body: JSON.stringify(body) });
  window.__mbCalls = [];
  window.fb2k.invoke = async (m, p = {}) => {
    if (m === 'http.get' && /musicbrainz\.org\/ws\/2\/(artist|release-group)/.test(p.url)) {
      window.__mbCalls.push(p.url);
      const u = decodeURIComponent(p.url);
      const q = u.match(/artist:"([^"]+)"/);
      if (q) { const n = q[1].trim(); return ok({ artists: MB[n] ? [{ id: 'mb-' + n, name: n, score: 100, tags: [{ name: MB[n][0], count: 3 }] }] : [] }); }
      const rg = u.match(/release-group\?artist=mb-([^&]+)/);
      if (rg) { const n = rg[1]; return ok({ 'release-groups': [{ id: 'rg-' + n, title: ALB[n], genres: [{ name: MB[n][1], count: 4 }, { name: MB[n][0], count: 2 }] }] }); }
      const art = u.match(/artist\/mb-([^?]+)\?inc=genres/);
      if (art) { const n = art[1]; return ok({ id: 'mb-' + n, name: n, genres: [{ name: MB[n][0], count: 9 }, { name: MB[n][1], count: 3 }] }); }
      return ok({});
    }
    return base(m, p);
  };
})();
