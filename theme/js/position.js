/*
 * Gatefold · position.js — the playback position, for lyrics and the seek bar.
 *
 * foo_ui_webview2 sends two position events:
 *   playback:time        ~1 Hz, whole seconds, no timestamp — meant for a time display only;
 *   playback:timeHighRes ~10 Hz, fractional, latency-compensated, with hostTime (Date.now clock).
 * Following the coarse one made synced lyrics run ahead of (or jitter around) the singer, so
 * the fine one drives the position and the coarse one is only a fallback for components that
 * do not send it. After a seek the next fine sample may still carry the old position, so
 * samples far from the seek target are ignored for a moment.
 *
 *   const pos = follower({ set: (p, dur) => …, get: () => sec, playing: () => bool });
 *   on('playback:timeHighRes', pos.fine); on('playback:time', pos.coarse); on('playback:seeked', (d) => pos.seeked(d.position));
 *   pos.seeked(p)   — also when the page itself asked for a seek
 *   pos.sample(r)   — a playback.getPosition / stateChanged result
 */
const now = () => performance.now();
/** how long ago (s) the host read the position; 0 when the stamp is missing or implausible */
export const lagOf = (hostTime) => {
  const l = (Date.now() - +hostTime) / 1000;
  return +hostTime > 0 && l > 0 && l < 1.5 ? l : 0;
};

export function follower({ set, get, playing = () => true }) {
  let fineAt = -1e9, seekTo = null, seekAt = -1e9;
  const settling = (p) => seekTo != null && now() - seekAt < 700 && Math.abs(p - seekTo) > 1.2;
  return {
    fine(d) {
      const p = +(d && d.position);
      if (!Number.isFinite(p)) return;
      fineAt = now();
      if (settling(p)) return;                          // sampled before the seek landed
      seekTo = null;
      const est = p + lagOf(d.hostTime);
      if (Math.abs(est - get()) < 0.03) return;         // already there: no needless re-anchoring
      set(est);
    },
    coarse(d) {
      if (now() - fineAt < 2500) return;                // the fine stream is alive: ignore whole seconds
      const p = +(d && d.position);
      if (Number.isFinite(p) && !settling(p)) set(p);
    },
    seeked(p) {
      p = +p;
      if (!Number.isFinite(p)) return;
      seekTo = p; seekAt = now();
      set(p);
    },
    sample(r) {
      const p = +(r && r.position);
      if (!Number.isFinite(p) || settling(p)) return;
      set(p + (playing() ? lagOf(r.hostTime) : 0), r.duration != null && +r.duration > 0 ? +r.duration : null);
    },
  };
}
