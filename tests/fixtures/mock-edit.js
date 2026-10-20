// mock-edit.js — playlist {A} becomes editable: remove, reorder, undo/redo, addHandles, selection,
// queue.add, reorderPlaylists. The rows live in window.__plA (loaded from the base mock on first use).
(() => {
  if (window.__emptyMusic) return;
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const E = window.__edit = { rows: null, undo: [], redo: [], sel: [], order: null, added: {} };
  const rec = (m, p) => window.__calls.push([m, JSON.stringify(p)]);
  const load = async () => { if (!E.rows) { const r = await base('playlist.getTracks', { start: 0, count: 100000 }); E.rows = r.tracks.map((t) => ({ ...t })); } return E.rows; };
  const snap = () => { E.undo.push(E.rows.slice()); E.redo = []; };
  const changed = (ev) => setTimeout(() => window.__emit(ev, { playlistGuid: '{A}', playlist: 0 }), 10);
  const isA = (p) => !p.playlistGuid || p.playlistGuid === '{A}';
  window.fb2k.invoke = async (m, p = {}) => {
    if (m === 'playlist.getAll') { const r = await base(m, p); await load(); r.playlists = r.playlists.map((x) => (x.guid === '{A}' ? { ...x, trackCount: E.rows.length } : x));
      if (E.order) r.playlists.sort((a, b) => E.order.indexOf(a.guid) - E.order.indexOf(b.guid)); return r; }
    if (m === 'playlist.getActive') { const r = await base(m, p); await load(); return { ...r, trackCount: E.rows.length }; }
    if (m === 'playlist.getTracks' && isA(p)) { await load(); const s = p.start || 0; return ok({ tracks: E.rows.slice(s, s + (p.count || 100)).map((t, i) => ({ ...t, index: s + i })), total: E.rows.length }); }
    if (m === 'playlist.getGroupRuns' && isA(p)) { await load(); const runs = []; E.rows.forEach((t, i) => { const k = t.albumArtist + ' | ' + t.album; if (!runs.length || runs[runs.length - 1].key !== k) runs.push({ start: i, count: 0, key: k }); runs[runs.length - 1].count++; }); return ok({ runs, total: E.rows.length }); }
    if (m === 'playlist.removeTracks' && isA(p)) { rec(m, p); await load(); snap(); const S = new Set(p.items); E.rows = E.rows.filter((_, i) => !S.has(i)); changed('playlist:itemsRemoved'); return ok({}); }
    if (m === 'playlist.reorder' && isA(p)) { rec(m, { n: p.newOrder.length, head: p.newOrder.slice(0, 8) }); await load(); snap(); E.rows = p.newOrder.map((i) => E.rows[i]); changed('playlist:itemsReordered'); return ok({ count: E.rows.length }); }
    if (m === 'playlist.undo' && isA(p)) { rec(m, p); if (E.undo.length) { E.redo.push(E.rows); E.rows = E.undo.pop(); changed('playlist:itemsReplaced'); } return ok({}); }
    if (m === 'playlist.redo' && isA(p)) { rec(m, p); if (E.redo.length) { E.undo.push(E.rows); E.rows = E.redo.pop(); changed('playlist:itemsReplaced'); } return ok({}); }
    if (m === 'playlist.setSelection') { E.sel = p.indices; return ok({}); }
    if (m === 'playlist.addHandles') { if (p.playlistGuid !== '{L}') { rec(m, { guid: p.playlistGuid, n: p.handles.length }); E.added[p.playlistGuid] = (E.added[p.playlistGuid] || 0) + p.handles.length; return ok({ playlistGuid: p.playlistGuid }); } }
    if (m === 'queue.add') { rec(m, p); return ok({ added: (p.tracks || []).length }); }
    if (m === 'playlist.reorderPlaylists') { rec(m, p); E.order = p.newOrderGuids; setTimeout(() => window.__emit('playlist:reordered', {}), 10); return ok({}); }
    if (m === 'menu.showNativePopup') { rec(m, p); return ok({}); }
    return base(m, p);
  };
})();
