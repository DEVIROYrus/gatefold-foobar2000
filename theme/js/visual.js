/*
 * Gatefold · visual.js — the visualiser chosen in Settings → Canvas: Gatefold's own (aura.js) or the
 * classic MilkDrop (milkdrop.js). Both offer the same stage — start / stop / next / lock, the name of what
 * shows — so Canvas and Now Playing do not care which one it is.
 */
import { settings } from './settings.js';
import { $t } from './i18n.js';
import * as MD from './milkdrop.js';
import * as AU from './aura.js';

/** 'gatefold' | 'milkdrop' | 'off' (also 'off' without WebGL 2) */
export function engine() {
  const v = settings.visual || 'gatefold';
  if (v === 'milkdrop') return MD.supported() ? 'milkdrop' : 'off';
  if (v === 'gatefold') return AU.supported() ? 'gatefold' : 'off';
  return 'off';
}
export const supported = () => AU.supported();
export function createStage(host, opts) {
  const e = engine();
  const s = e === 'milkdrop' ? new MD.Stage(host, opts) : new AU.Stage(host, opts);
  s.engine = e;
  return s;
}
const SCENE = () => ({ face: $t('Фас'), land: $t('Ландшафт'), orbit: $t('Облёт'), macro: $t('Макро') });
/** what shows, for people: «Orbit» or «dedicated to the sherwin maxawow — Flexi, martin + geiss» */
export function nameOf(eng, id) {
  if (!id) return '';
  if (eng === 'gatefold') return SCENE()[id] || id;
  const m = String(id).replace(/^[$!_\s-]+/, '').match(/^(.*?)\s+-\s+(.+)$/);
  return m ? `${m[2]} — ${m[1]}` : id;
}
export const sceneLabels = () => Object.entries(SCENE());
export function setMoodProvider(fn) { MD.setMoodProvider(fn); AU.setMoodProvider(fn); }
export const preload = () => (engine() === 'milkdrop' ? MD.preload() : Promise.resolve());
