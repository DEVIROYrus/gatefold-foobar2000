/*
 * Gatefold · rg-now.js — the ReplayGain gain foobar2000 applies to the track that is playing.
 *
 * foo_ui_webview2's live audio stream is taken before ReplayGain (and before the volume
 * control), so a meter that should show what is actually played multiplies by this gain.
 * It follows foobar2000's own rules (replaygain_info / ReplayGain settings):
 *   source   none · track · album · by playback order (track gain in Random / Shuffle (tracks),
 *            album gain otherwise); a missing value falls back to the other one
 *   gain     value + «preamp with RG», or «preamp without RG» when the track has no values
 *   process  gain · gain and peak (never above 1 / peak) · peak only · none
 * Read once per track change and whenever a ReplayGain setting or the playback order changes.
 *
 *   now.gain   linear factor (1 when ReplayGain does nothing)
 *   now.lufs   loudness of the track / album before the gain, from its ReplayGain value (null if unknown)
 */
import { call, ok, on } from './bridge.js';

export const now = { gain: 1, lufs: null, db: 0 };
let wired = false, seq = 0, cfg = null, order = 0;

async function refresh() {
  const my = ++seq;
  const [cur, st, ord] = await Promise.all([call('playback.getCurrentTrack'), cfg ? null : call('replaygain.getSettings'), call('playback.getPlaybackOrder')]);
  if (st && ok(st)) cfg = st;
  if (ok(ord)) order = +(ord.orderIndex ?? ord.order) || 0;
  const t = ok(cur) && cur.found !== false ? (cur.track || cur) : null;
  const path = t && (t.absolutePath || t.path);
  let rg = null;
  if (path) {
    const r = await call('replaygain.get', { paths: [t.subsong > 0 ? `${path}|subsong:${t.subsong}` : path] });
    rg = ok(r) && r.results && r.results[0] && r.results[0].success ? r.results[0] : null;
  }
  if (my !== seq) return;
  Object.assign(now, compute(cfg, order, rg));
}

/** foobar2000's ReplayGain scale for one track's values */
export function compute(c, playbackOrder, rg) {
  if (!c || c.sourceMode === 'none' || c.processingMode === 'none') return { gain: 1, lufs: null, db: 0 };
  const shuffleTracks = playbackOrder === 3 || playbackOrder === 4;        // Random, Shuffle (tracks)
  const useAlbum = c.sourceMode === 'album' || (c.sourceMode === 'auto' && !shuffleTracks);
  const has = (v) => typeof v === 'number' && Number.isFinite(v);
  const tg = rg && rg.trackGainRaw, ag = rg && rg.albumGainRaw, tp = rg && rg.trackPeakRaw, ap = rg && rg.albumPeakRaw;
  const g = useAlbum ? (has(ag) ? ag : tg) : (has(tg) ? tg : ag);
  const pk = useAlbum ? (has(ap) ? ap : tp) : (has(tp) ? tp : ap);
  const lufs = has(g) ? -18 - g : null;
  let db = 0;
  if (c.processingMode !== 'peak') db = has(g) ? g + (+c.preampWithRg || 0) : (+c.preampWithoutRg || 0);
  let scale = 10 ** (db / 20);
  if ((c.processingMode === 'gain_and_peak' || c.processingMode === 'peak') && has(pk) && pk > 0) scale = Math.min(scale, 1 / pk);
  return { gain: scale, lufs, db: 20 * Math.log10(scale) };
}

/** start following (idempotent) */
export function follow() {
  if (wired) return; wired = true;
  on('playback:trackChanged', () => refresh());
  on('playback:orderChanged', (d) => { order = +(d.orderIndex ?? d.order) || 0; refresh(); });
  on('audio:replaygainModeChanged', () => { cfg = null; refresh(); });
  refresh();
}
