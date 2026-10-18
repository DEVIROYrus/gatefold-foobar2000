// mock3.js — extends mock2 for 1.9: likes playlist, split albums, YouTube, lyrics providers, fake IFrame player.
(() => {
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const b64 = (s) => btoa(unescape(encodeURIComponent(s)));
  const liked = { exists: false, items: [], name: 'Понравившиеся' };
  window.__liked = liked;
  const qp = (u) => new URLSearchParams(u.split('?')[1] || '');

  // ---- YouTube fixtures
  const vids = (n, off = 0) => Array.from({ length: n }, (_, i) => {
    const k = i + off, id = ('vid' + String(k).padStart(3, '0') + 'xxxxxxxx').slice(0, 11);
    return { videoRenderer: { videoId: id, title: { runs: [{ text: ['Lumen Arcade — Nightdrive (Official Video)', 'Synthwave mix 2026 · 1 hour', 'Blue Hours live at Tempodrom', 'How the 808 changed music', 'Mirage Theory — Paper Moons (lyrics)', 'Rainy night lo-fi radio'][k % 6] + (k > 5 ? ' #' + k : '') }] },
      ownerText: { runs: [{ text: ['Lumen Arcade', 'NightRide FM', 'Blue Hours', 'Vox', 'Mirage Theory', 'Lofi Girl'][k % 6] }] },
      lengthText: k % 6 === 5 ? undefined : { simpleText: ['3:58', '1:02:11', '7:41', '12:05', '3:39', ''][k % 6] },
      badges: k % 6 === 5 ? [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_LIVE_NOW', label: 'LIVE' } }] : [],
      shortViewCountText: { simpleText: ['2,4 млн просмотров', '880 тыс. просмотров', '1,1 млн просмотров', '4 млн просмотров', '96 тыс. просмотров', '31 тыс. смотрят'][k % 6] },
      publishedTimeText: k % 6 === 5 ? undefined : { simpleText: ['3 года назад', '8 месяцев назад', '1 год назад', '5 лет назад', '2 недели назад', ''][k % 6] } } };
  });
  const ytHtml = (q) => `<html><script>var ytcfg={};ytcfg.set({"INNERTUBE_API_KEY":"AIzaFAKE","INNERTUBE_CLIENT_VERSION":"2.20261001.00.00"});</script><script nonce="x">var ytInitialData = ${JSON.stringify({ contents: { twoColumnSearchResultsRenderer: { primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: vids(12) } }, { continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: 'CONT1' } } } }] } } } } })};</script><script>var x=1;</script></html>`;

  window.fb2k.invoke = async (m, p = {}) => {
    if (m === 'lyrics.get' && window.__noLocal) return ok({ available: false, path: p.path });
    // ---- likes playlist
    if (m === 'playlist.getAll') { const r = await base(m, p); if (liked.exists) r.playlists = [{ index: 0, guid: '{L}', name: liked.name, trackCount: liked.items.length }, ...r.playlists]; return r; }
    if (m === 'playlist.create' && (p.name === 'Понравившиеся' || p.name === 'Liked')) { liked.exists = true; liked.name = p.name; window.__calls.push(['playlist.create', p.name, p.position]); return ok({ index: 0, guid: '{L}' }); }
    if (m === 'playlist.getTracks' && p.playlistGuid === '{L}') { const all = (await base('playlist.getTracks', { start: 0, count: 1000 })).tracks; return ok({ playlistGuid: '{L}', tracks: liked.items.slice(p.start || 0, (p.start || 0) + (p.count || 100)).map((h, i) => ({ ...(all.find((t) => (t.handle || t.absolutePath) === h) || { title: h.split('\\').pop() }), index: (p.start || 0) + i, handle: h })), total: liked.items.length }); }
    if (m === 'playlist.addHandles' && p.playlistGuid === '{L}') { liked.items.push(...p.handles); window.__calls.push(['playlist.addHandles', JSON.stringify(p.handles)]); setTimeout(() => window.__emit('playlist:itemsAdded', { playlistGuid: '{L}' }), 20); return ok({ playlistGuid: '{L}' }); }
    if (m === 'playlist.removeTracks' && p.playlistGuid === '{L}') { liked.items = liked.items.filter((_, i) => !p.items.includes(i)); window.__calls.push(['playlist.removeTracks', JSON.stringify(p.items)]); setTimeout(() => window.__emit('playlist:itemsRemoved', { playlistGuid: '{L}' }), 20); return ok({}); }
    // ---- an album split by a guest artist (same folder)
    if (m === 'library.getAlbums') {
      const r = await base(m, p);
      if (!(p.offset > 0) && !p.query) r.albums = [...r.albums,
        { name: 'file. 07', albumArtist: 'YUJU', artist: 'YUJU, JUNNY', year: '2026', genre: 'K-Pop', trackCount: 4, duration: 820, firstTrackAbsolutePath: 'D:\\Music\\YUJU\\file. 07\\01.flac' },
        { name: 'file. 07', albumArtist: 'YUJU, JUNNY', artist: 'YUJU, JUNNY', year: '2026', genre: 'K-Pop', trackCount: 1, duration: 201, firstTrackAbsolutePath: 'D:\\Music\\YUJU\\file. 07\\03.flac' }];
      return r;
    }
    if (m === 'library.getAlbumTracks' && p.album === 'file. 07') {
      const mk = (n, a) => ({ title: ['Sunset', 'Room', 'Moonwalk', 'Hush', 'Ending credits'][n - 1], artist: a, album: 'file. 07', albumArtist: p.albumArtist, trackNumber: n, discNumber: 1, duration: 200, codec: 'FLAC', absolutePath: `D:\\Music\\YUJU\\file. 07\\0${n}.flac`, handle: `D:\\Music\\YUJU\\file. 07\\0${n}.flac` });
      return ok({ tracks: p.albumArtist === 'YUJU' ? [1, 2, 4, 5].map((n) => mk(n, 'YUJU')) : [mk(3, 'YUJU, JUNNY')] });
    }
    if (/^playback\.(pause|play|stop)/.test(m)) window.__calls.push([m]);
    if (m === 'window.setAlwaysOnTop' || m === 'window.setFullscreen') window.__calls.push([m, JSON.stringify(p)]);
    if (m === 'window.setFullscreen') return ok({ fullscreen: !!p.enabled });
    if (m === 'window.getBounds') return ok({ x: 100, y: 80, width: 1600, height: 940 });
    if (m === 'window.closePopup') { window.__calls.push(['window.closePopup', p.windowId]); return ok({}); }
    // ---- http
    if (m === 'http.post' && /youtubei\/v1\/search/.test(p.url)) { window.__calls.push(['http.post', p.url]); return ok({ status: 200, body: JSON.stringify({ onResponseReceivedCommands: [{ appendContinuationItemsAction: { continuationItems: [{ itemSectionRenderer: { contents: vids(8, 12) } }] } }] }) }); }
    if (m === 'http.get') {
      const u = p.url;
      if (/googleapis\.com\/youtube\/v3\/search/.test(u)) { window.__calls.push(['ytapi.search', u]); const items = vids(10).map((v) => ({ id: { videoId: v.videoRenderer.videoId }, snippet: { title: v.videoRenderer.title.runs[0].text.replace('&', '&amp;'), channelTitle: v.videoRenderer.ownerText.runs[0].text, publishedAt: '2024-05-01T10:00:00Z', liveBroadcastContent: 'none', description: '' } })); return ok({ status: 200, body: JSON.stringify({ items, nextPageToken: 'PT2' }) }); }
      if (/googleapis\.com\/youtube\/v3\/videos/.test(u)) { const ids = decodeURIComponent(qp(u).get('id')).split(','); return ok({ status: 200, body: JSON.stringify({ items: ids.map((id, i) => ({ id, contentDetails: { duration: i % 3 ? 'PT3M58S' : 'PT1H2M11S' }, statistics: { viewCount: String(1234567 * (i + 1)) } })) }) }); }
      if (/youtube\.com\/results/.test(u)) { window.__calls.push(['http.get', u]); return ok({ status: 200, body: ytHtml(qp(u).get('search_query')) }); }
      if (/suggestqueries/.test(u)) { const q = qp(u).get('q'); return ok({ status: 200, body: `window.google.ac.h(["${q}",[["${q} official",0],["${q} live",0],["${q} lyrics",0],["${q} remix",0]],{"k":1}])` }); }
      if (/youtube\.com\/oembed/.test(u)) { const id = decodeURIComponent(qp(u).get('url')).split('v=')[1]; return ok({ status: 200, body: JSON.stringify({ title: 'Linked video ' + id, author_name: 'Some Channel' }) }); }
      if (/i\.ytimg\.com/.test(u) && p.responseType === 'base64') { const f = ['/covers/neon.jpg', '/covers/forest.jpg', '/covers/ocean.jpg', '/covers/desert.jpg'][u.length % 4]; const b = new Uint8Array(await (await fetch(f)).arrayBuffer()); let s = ''; for (const x of b) s += String.fromCharCode(x); return ok({ status: 200, body: btoa(s) }); }
      // lyrics providers (echo the queried title)
      if (/apic-desktop\.musixmatch\.com\/ws\/1\.1\/token\.get/.test(u)) return ok({ status: 200, body: JSON.stringify({ message: { header: { status_code: 200 }, body: { user_token: 'tok123' } } }) });
      if (/macro\.subtitles\.get/.test(u)) {
        const q = qp(u), title = q.get('q_track');
        const rich = [[1.5, 'Low tide comes'], [6.2, 'and takes the shore'], [11.8, 'we stay awake'], [17, 'a little more']].map(([ts, x]) => ({ ts, te: ts + 4, x, l: x.split(/( )/).map((c, i, a) => ({ c, o: a.slice(0, i).join('').length * 0.18 })) }));
        return ok({ status: 200, body: JSON.stringify({ message: { header: { status_code: 200 }, body: { macro_calls: {
          'matcher.track.get': { message: { header: { status_code: 200 }, body: { track: { track_name: title, artist_name: q.get('q_artist'), track_length: +q.get('q_duration') || 0, has_richsync: 1 } } } },
          'track.richsync.get': { message: { body: { richsync: { richsync_body: JSON.stringify(rich) } } } },
          'track.subtitles.get': { message: { body: { subtitle_list: [{ subtitle: { subtitle_body: JSON.stringify(rich.map((r) => ({ text: r.x, time: { total: r.ts } }))) } }] } } },
          'track.lyrics.get': { message: { body: { lyrics: { lyrics_body: rich.map((r) => r.x).join('\n') + '\n...\n******* This Lyrics is NOT for Commercial use *******' } } } },
        } } } }) });
      }
      if (/music\.163\.com\/api\/search/.test(u)) { const s = qp(u).get('s'); return ok({ status: 200, body: JSON.stringify({ code: 200, result: { songs: [{ id: 777, name: s.replace(/^Mirage Theory /, ''), artists: [{ name: 'Mirage Theory' }], duration: 0 }] } }) }); }
      if (/music\.163\.com\/api\/song\/lyric\/v1/.test(u)) return ok({ status: 200, body: JSON.stringify({ code: 200, yrc: { lyric: '{"t":0,"c":[{"tx":"作词: "},{"tx":"X"}]}\n[1000,2000](1000,500,0)Net(1500,500,0)ease \n[4000,2000](4000,600,0)word(4600,600,0)sync \n[8000,2000](8000,600,0)third(8600,600,0)line' } }) });
      if (/music\.163\.com\/api\/song\/lyric/.test(u)) return ok({ status: 200, body: JSON.stringify({ code: 200, lrc: { lyric: '[00:00.00]作词 : Somebody\n[00:01.00]NetEase line one\n[00:04.00]NetEase line two\n[00:08.00]NetEase line three' } }) });
      if (/client_search_cp/.test(u)) { const w = qp(u).get('w'); return ok({ status: 200, body: `callback(${JSON.stringify({ code: 0, data: { song: { list: [{ mid: '00QQ', name: w.replace(/^Mirage Theory /, ''), singer: [{ name: 'Mirage Theory' }], interval: 0 }] } } })})` }); }
      if (/fcg_query_lyric_new/.test(u)) return ok({ status: 200, body: JSON.stringify({ retcode: 0, code: 0, lyric: b64('[00:01.00]QQ line one\n[00:05.00]QQ line two\n[00:09.00]QQ line three') }) });
      if (/lyrics\.kugou\.com\/search/.test(u)) { const kw = qp(u).get('keyword'); return ok({ status: 200, body: JSON.stringify({ status: 200, candidates: [{ id: '1', accesskey: 'k', song: kw.split(' - ')[1], singer: kw.split(' - ')[0], duration: 0 }] }) }); }
      if (/lyrics\.kugou\.com\/download/.test(u)) return ok({ status: 200, body: JSON.stringify({ status: 200, content: b64('[00:01.00]Kugou line one\n[00:05.00]Kugou line two\n[00:09.00]Kugou line three') }) });
    }
    return base(m, p);
  };

  // ---- fake IFrame Player API (the real one needs the network)
  class FakePlayer {
    constructor(el, o) {
      const target = typeof el === 'string' ? document.getElementById(el) : el;
      const f = document.createElement('div'); f.className = 'fakeyt';
      f.style.cssText = 'position:absolute;inset:0;background:radial-gradient(circle at 30% 40%,#ff7b54,#5b2a86 60%,#120b2a);display:grid;place-items:center;color:#fff;font:700 28px sans-serif';
      target.replaceWith(f); this.f = f; this.o = o; this.t = 0; this.d = 245; this.st = -1; this.vid = o.videoId; this.vol = 100; this.rate = 1; window.__yt = this;
      setTimeout(() => { o.events.onReady && o.events.onReady({ target: this }); if (this.vid) this._play((o.playerVars || {}).start || 0); }, 60);
    }
    _play(s) { this.t = s; this.st = 1; this.f.textContent = '▶ ' + this.vid; this.o.events.onStateChange({ data: 1 }); clearInterval(this.iv); this.iv = setInterval(() => { if (this.st === 1) this.t += 0.25; }, 250); }
    loadVideoById(o) { this.vid = o.videoId; this._play(o.startSeconds || 0); }
    cuePlaylist() { this.pl = ['plv00000001', 'plv00000002', 'plv00000003']; setTimeout(() => this.o.events.onStateChange({ data: 5 }), 40); }
    getPlaylist() { return this.pl || []; }
    playVideo() { this.st = 1; this.o.events.onStateChange({ data: 1 }); }
    pauseVideo() { this.st = 2; this.o.events.onStateChange({ data: 2 }); }
    stopVideo() { this.st = 5; }
    getPlayerState() { return this.st; } getCurrentTime() { return this.t; } getDuration() { return this.d; }
    getVideoLoadedFraction() { return Math.min(1, (this.t + 60) / this.d); }
    seekTo(s) { this.t = s; } setVolume(v) { this.vol = v; } mute() {} unMute() {}
    setPlaybackRate(r) { this.rate = r; this.o.events.onPlaybackRateChange && this.o.events.onPlaybackRateChange({ data: r }); }
    getAvailablePlaybackRates() { return [0.5, 1, 1.25, 1.5, 2]; }
    getAvailableQualityLevels() { return ['hd1080', 'hd720', 'large', 'medium', 'small', 'tiny', 'auto']; }
    getPlaybackQuality() { return this.q || 'hd720'; } setPlaybackQuality(q) { this.q = q; }
    getIframe() { return this.f; }
    getVideoData() { return { video_id: this.vid, title: '', author: '' }; }
  }
  window.YT = { Player: FakePlayer };
})();
