// Settings live in localStorage, which every Glance window shares. A change is
// broadcast so the tracker picks it up without a restart.
import { emit } from './api.js';

const KEY = 'glance:prefs';
export const DEFAULTS = {
  enabled: true,
  movePointer: false,
  dwell: 350, // ms you must keep facing a screen before focus moves
  typingDelay: 700, // ms without typing or mousing before focus may move
  showPill: true,
  fps: 15,
};

export function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function save(prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs));
  } catch {}
  emit('glance://prefs', prefs);
}

const CAL = 'glance:calibration';

/** A screen layout fingerprint, so calibration is dropped when monitors change. */
export function signature(screens) {
  return screens.map((s) => `${Math.round(s.x)},${Math.round(s.y)},${Math.round(s.w)}x${Math.round(s.h)}`).join('|');
}

export function loadCalibration(screens) {
  try {
    const c = JSON.parse(localStorage.getItem(CAL) || 'null');
    return c && c.signature === signature(screens) ? c.screens : null;
  } catch {
    return null;
  }
}

export function saveCalibration(screens, centers) {
  try {
    localStorage.setItem(CAL, JSON.stringify({ signature: signature(screens), screens: centers.map((center) => ({ center })) }));
  } catch {}
}
