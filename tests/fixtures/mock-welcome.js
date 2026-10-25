// mock-welcome.js — a fresh foobar2000 with no music, when window.__emptyMusic is set before load:
// empty library, one empty playlist, nothing playing. Opening a folder fills a playlist; setting
// window.__wl.lib > 0 makes the library "find" music (as after Preferences → Media Library → Add).
(() => {
  if (!window.__emptyMusic) return;
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const W = window.__wl = { lib: 0, noMusic: false, pls: [{ index: 0, guid: '{D}', name: 'Default', trackCount: 0, isActive: true }] };
  const rec = (m, p) => window.__calls.push([m, JSON.stringify(p)]);
  window.fb2k.invoke = async (m, p = {}) => {
    switch (m) {
      case 'config.getLibraryStatus': return ok({ enabled: W.lib > 0, itemCount: W.lib, initialized: true });
      case 'library.getRoots': return ok({ enabled: W.lib > 0, roots: [], total: 0 });
      case 'playlist.getAll': return ok({ playlists: W.pls.map((x, i) => ({ ...x, index: i })) });
      case 'playlist.getActive': { const a = W.pls.find((x) => x.isActive) || W.pls[0]; return ok({ found: true, ...a, duration: 0 }); }
      case 'playback.getCurrentTrack': if (!W.playing) return ok({ found: false }); break;
      case 'playback.getState': if (!W.playing) return ok({ state: 'stopped' }); break;
      case 'playback.getCurrentTrackIndex': if (!W.playing) return ok({ found: false }); break;
      case 'library.getAlbums': if (!W.lib) return ok({ albums: [], total: 0, hasMore: false }); break;
      case 'library.query': if (!W.lib) return ok({ tracks: [], total: 0 }); break;
      case 'playlist.getTracks': { const pl = W.pls.find((x) => x.guid === p.playlistGuid); if (pl && !pl.trackCount) return ok({ tracks: [], total: 0 }); break; }
      case 'playlist.getGroupRuns': { const pl = W.pls.find((x) => x.guid === p.playlistGuid); if (pl && !pl.trackCount) return ok({ runs: [], total: 0 }); break; }
      case 'config.showLibraryPreferences': rec(m, p); return ok({});
      case 'dialog.openFolder': rec(m, p); return ok({ canceled: false, folderPath: 'D:\\Music\\Lumen Arcade' });
      case 'dialog.openFile': rec(m, p); return ok({ canceled: false, filePaths: ['D:\\Music\\a.flac', 'D:\\Music\\b.flac'] });
      case 'playlist.create': { rec(m, p); const g = '{N' + W.pls.length + '}'; W.pls.push({ guid: g, name: p.name, trackCount: 0 }); return ok({ index: W.pls.length - 1, guid: g }); }
      case 'playlist.addPathsAsync': { rec(m, p); const pl = W.pls.find((x) => x.guid === p.playlistGuid);
        setTimeout(() => { pl.trackCount = 12; window.__emit('playlist:addComplete', { operationId: 'op1', playlistGuid: p.playlistGuid, success: true, addedCount: 12, totalCount: 1 }); window.__emit('playlist:itemsAdded', { playlistGuid: p.playlistGuid }); }, 60);
        return ok({ operationId: 'op1', playlistGuid: p.playlistGuid, status: 'pending', totalCount: p.paths.length, invalidCount: 0 }); }
      case 'playlist.addPaths': { rec(m, p); const pl = W.pls.find((x) => x.guid === p.playlistGuid);
        if (W.noMusic) return { success: false, code: 'NOT_FOUND', error: 'Nothing was added' };
        const before = pl.trackCount; pl.trackCount += 12; setTimeout(() => window.__emit('playlist:itemsAdded', { playlistGuid: p.playlistGuid }), 30);
        return ok({ playlistGuid: p.playlistGuid, requestedPaths: p.paths.length, addedCount: 12, invalidCount: 0, countBefore: before, totalCount: pl.trackCount }); }
      case 'playlist.remove': { rec(m, p); W.pls = W.pls.filter((x) => x.guid !== p.playlistGuid); return ok({}); }
      case 'playlist.setActive': rec(m, p); W.pls.forEach((x) => (x.isActive = x.guid === p.playlistGuid)); return ok({});
      case 'playlist.playTrack': rec(m, p); W.playing = true; return ok({});
    }
    return base(m, p);
  };
})();
