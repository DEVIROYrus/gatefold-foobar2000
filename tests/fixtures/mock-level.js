// mock-level.js — volume levelling (loudness.js): a small library with known loudness, foobar2000's
// ReplayGain tags kept in window.__level.tags, tag writes that complete asynchronously, and
// decoding that synthesises each track as a stereo tone at its own level. Only with __levelTest.
(() => {
  if (!window.__levelTest) return;
  const base = window.fb2k.invoke.bind(window.fb2k);
  const ok = (x) => Promise.resolve({ success: true, ...x });
  const SR = 8000;
  const T = (absolutePath, album, albumArtist, artist, amp, extra = {}) => ({ absolutePath, subsong: 0, album, albumArtist, artist, title: absolutePath.split('\\').pop(), duration: 12, sampleRate: SR, channels: 2, codec: 'FLAC', amp, ...extra });
  const L = window.__level = { tags: {}, writes: [], noKeep: /\.ape$/i, tracks: [] };
  const lib = L.tracks = [
    // one album on two discs (CD1 / CD2 folders): two loud songs and a quiet interlude
    T('D:\\Music\\Night Drive\\CD1\\01.flac', 'Night Drive', 'Neon', 'Neon', 0.5),
    T('D:\\Music\\Night Drive\\CD1\\02 Interlude.flac', 'Night Drive', 'Neon', 'Neon', 0.03),
    T('D:\\Music\\Night Drive\\CD2\\01.flac', 'Night Drive', 'Neon', 'Neon', 0.45),
    // a compilation: a different artist on every track, no album artist
    T('D:\\Music\\Mixtape\\01.flac', 'Mixtape', 'A1', 'A1', 0.2), T('D:\\Music\\Mixtape\\02.flac', 'Mixtape', 'A2', 'A2', 0.3), T('D:\\Music\\Mixtape\\03.flac', 'Mixtape', 'A3', 'A3', 0.25),
    // one title, two album artists, one folder: two albums
    ...[1, 2, 3].map((i) => T(`D:\\Music\\Live\\Alpha ${i}.flac`, 'Live', 'Alpha', 'Alpha', 0.4)),
    ...[1, 2, 3].map((i) => T(`D:\\Music\\Live\\Beta ${i}.flac`, 'Live', 'Beta', 'Beta', 0.1)),
    // a single without an album tag
    T('D:\\Music\\Singles\\One.flac', '', '', 'Solo', 0.15),
    // already tagged: nothing to do
    T('D:\\Music\\Tagged\\01.flac', 'Tagged', 'Old', 'Old', 0.3, { tagged: true }), T('D:\\Music\\Tagged\\02.flac', 'Tagged', 'Old', 'Old', 0.3, { tagged: true }),
    // an album scanned before, then a bonus track added: the old album gain must not stay
    T('D:\\Music\\Partial\\01.flac', 'Partial', 'Pt', 'Pt', 0.2, { stale: true }), T('D:\\Music\\Partial\\02.flac', 'Partial', 'Pt', 'Pt', 0.2, { stale: true }), T('D:\\Music\\Partial\\03 Bonus.flac', 'Partial', 'Pt', 'Pt', 0.4),
    // Opus: R128_* gains next to the REPLAYGAIN_* fields
    T('D:\\Music\\OpusAlb\\01.opus', 'Opus Album', 'Op', 'Op', 0.3), T('D:\\Music\\OpusAlb\\02.opus', 'Opus Album', 'Op', 'Op', 0.3),
    // a format whose tags do not keep the values
    T('D:\\Music\\Ape\\01.ape', 'Monkey', 'Ape', 'Ape', 0.2), T('D:\\Music\\Ape\\02.ape', 'Monkey', 'Ape', 'Ape', 0.2),
  ];
  for (const t of lib) if (t.stale) L.tags[t.absolutePath.toLowerCase()] = { REPLAYGAIN_TRACK_GAIN: '-3.00 dB', REPLAYGAIN_TRACK_PEAK: '0.200000', REPLAYGAIN_ALBUM_GAIN: '-3.00 dB', REPLAYGAIN_ALBUM_PEAK: '0.200000' };
  L.cleared = [];
  for (const t of lib) if (t.tagged) L.tags[t.absolutePath.toLowerCase()] = { REPLAYGAIN_TRACK_GAIN: '-6.00 dB', REPLAYGAIN_TRACK_PEAK: '0.300000', REPLAYGAIN_ALBUM_GAIN: '-6.00 dB', REPLAYGAIN_ALBUM_PEAK: '0.300000' };
  // the album that is playing gets its values only once playback moves on
  let playingAdded = false;
  const addPlaying = async () => {
    if (playingAdded) return; playingAdded = true;
    const c = (await base('playback.getCurrentTrack')).track;
    L.playing = c.absolutePath;
    lib.push(T(c.absolutePath, c.album, c.albumArtist, c.artist, 0.35), T(c.absolutePath.replace(/\d+\.flac$/, '99.flac'), c.album, c.albumArtist, c.artist, 0.35));
  };
  const tag = (p) => L.tags[String(p).toLowerCase()] || {};
  const num = (s) => (s == null ? undefined : parseFloat(s));
  let task = 0;
  window.fb2k.invoke = async (m, p = {}) => {
    if (m === 'library.query' && p.query === 'ALL' && (p.fields || []).includes('codec')) { await addPlaying(); return ok({ total: lib.length, tracks: lib.map(({ amp, tagged, stale, ...t }) => t) }); }
    if (m === 'library.query' && /replaygain_(track|album)_gain% MISSING/.test(p.query)) {
      await addPlaying();
      const f = /track/.test(p.query) ? 'REPLAYGAIN_TRACK_GAIN' : 'REPLAYGAIN_ALBUM_GAIN';
      const rows = lib.filter((t) => tag(t.absolutePath)[f] == null).map((t) => ({ absolutePath: t.absolutePath, subsong: 0 }));
      return ok({ total: rows.length, tracks: rows });
    }
    if (m === 'replaygain.get') {
      const results = (p.paths || []).map((path) => { const x = tag(path); return { path, success: true, hasReplayGain: x.REPLAYGAIN_TRACK_GAIN != null || x.REPLAYGAIN_ALBUM_GAIN != null, trackGainRaw: num(x.REPLAYGAIN_TRACK_GAIN), trackPeakRaw: num(x.REPLAYGAIN_TRACK_PEAK), albumGainRaw: num(x.REPLAYGAIN_ALBUM_GAIN), albumPeakRaw: num(x.REPLAYGAIN_ALBUM_PEAK) }; });
      return ok({ count: results.length, results });
    }
    if (m === 'replaygain.clear') { for (const p2 of p.paths) { L.cleared.push(p2); setTimeout(() => { delete L.tags[p2.toLowerCase()]; }, 30); } return ok({ clearedCount: p.paths.length }); }
    if (m === 'metadata.writeBatch') {
      for (const it of p.items) {
        L.writes.push({ path: it.path, tags: it.tags, at: Date.now() });
        setTimeout(() => {
          if (!L.noKeep.test(it.path)) L.tags[it.path.toLowerCase()] = { ...tag(it.path), ...it.tags };
          window.__emit('metadata:writeComplete', { operation: 'write', path: it.path, subsong: 0, code: 0, success: true, status: 'success' });
        }, 40);
      }
      return ok({ successCount: p.items.length, failCount: 0, errors: [] });
    }
    if (m === 'audio.decodePcm') {
      const t = lib.find((x) => x.absolutePath.toLowerCase() === String(p.path).split('|')[0].toLowerCase());
      if (!t) return base(m, p);
      if (!(p.start > 0)) (L.decoded = L.decoded || []).push(t.absolutePath);
      const start = p.start || 0, end = Math.min(t.duration, p.end || t.duration);
      if (start >= t.duration) { const taskId = 'lvl_' + (++task); setTimeout(() => window.__emit('audio:pcmFailed', { taskId, code: 'INVALID_PARAMS', error: 'start past the end' }), 5); return ok({ taskId, status: 'pending' }); }
      const n = Math.round((end - start) * SR), buf = new ArrayBuffer(64 + n * 2 * 4);
      new DataView(buf).setUint32(24, n, true); new DataView(buf).setUint32(32, n, true);
      const f = new Float32Array(buf, 64);
      for (let i = 0; i < n; i++) { const v = t.amp * Math.sin(2 * Math.PI * 997 * (start + i / SR)); f[i] = v; f[n + i] = v; }
      const taskId = 'lvl_' + (++task);
      setTimeout(() => {
        window.__webviewDispatch('sharedbufferreceived', { getBuffer: () => buf, additionalData: { purpose: 'audio.decodePcm', taskId, sampleRate: SR, channels: 2, frames: n, headerBytes: 64 } });
        window.__emit('audio:pcmReady', { taskId, frames: n, start, end, duration: t.duration, truncated: false });
      }, 5);
      return ok({ taskId, status: 'pending' });
    }
    return base(m, p);
  };
})();
