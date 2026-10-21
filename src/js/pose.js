// Head direction from face landmarks, and the logic that decides which screen you're
// facing. Pure functions only, so they're tested without a camera.

// Landmark indices in MediaPipe's 478-point face mesh.
export const NOSE = 1;
export const LEFT_CHEEK = 234;
export const RIGHT_CHEEK = 454;
export const FOREHEAD = 10;
export const CHIN = 152;

/**
 * Turns landmarks into two numbers: how far the head is turned left/right (yaw) and
 * up/down (pitch), each roughly -1..1. They aren't degrees, but calibration maps them
 * to screens, so only their consistency matters.
 */
export function headPose(lm) {
  if (!lm || lm.length < 455) return null;
  const n = lm[NOSE];
  const l = lm[LEFT_CHEEK];
  const r = lm[RIGHT_CHEEK];
  const t = lm[FOREHEAD];
  const b = lm[CHIN];
  const width = r.x - l.x;
  const height = b.y - t.y;
  if (Math.abs(width) < 1e-4 || Math.abs(height) < 1e-4) return null;
  const yaw = ((n.x - l.x) - (r.x - n.x)) / width;
  const pitch = ((n.y - t.y) - (b.y - n.y)) / height;
  return { yaw, pitch, size: Math.abs(width) };
}

/** Exponential smoothing so a single jittery frame can't switch screens. */
export function smooth(prev, next, k = 0.35) {
  if (!prev) return { ...next };
  return { yaw: prev.yaw + (next.yaw - prev.yaw) * k, pitch: prev.pitch + (next.pitch - prev.pitch) * k, size: next.size };
}

/** Average of calibration samples, with outliers (blinks, glances) trimmed. */
export function centroid(samples) {
  if (!samples.length) return null;
  const trim = (vals) => {
    const s = [...vals].sort((a, b) => a - b);
    const cut = Math.floor(s.length * 0.15);
    const kept = s.slice(cut, s.length - cut || undefined);
    return kept.reduce((a, b) => a + b, 0) / kept.length;
  };
  return { yaw: trim(samples.map((p) => p.yaw)), pitch: trim(samples.map((p) => p.pitch)) };
}

const PITCH_WEIGHT = 0.7;
export function distance(a, b) {
  return Math.hypot(a.yaw - b.yaw, (a.pitch - b.pitch) * PITCH_WEIGHT);
}

/** Index of the calibrated screen nearest to the pose, with the distances to each. */
export function nearest(pose, screens) {
  let best = -1;
  let bestD = Infinity;
  const d = screens.map((s) => (s && s.center ? distance(pose, s.center) : Infinity));
  d.forEach((v, i) => {
    if (v < bestD) {
      bestD = v;
      best = i;
    }
  });
  return { index: best, distances: d };
}

/**
 * Decides when to switch screens. A switch needs the new screen to be clearly closer
 * than the current one (hysteresis) and to stay that way for `dwell` ms, so a quick
 * glance at your phone or a sneeze doesn't move your typing somewhere else.
 */
export class Switcher {
  constructor({ dwell = 350, margin = 0.8 } = {}) {
    this.dwell = dwell;
    this.margin = margin;
    this.current = -1;
    this.candidate = -1;
    this.since = 0;
  }

  /** Returns the screen to switch to, or -1 to stay put. */
  update(pose, screens, now) {
    const { index, distances } = nearest(pose, screens);
    if (index < 0) return -1;
    if (this.current < 0) {
      this.current = index;
      return -1; // first reading: just learn where we are
    }
    const clearlyBetter = index !== this.current && distances[index] < distances[this.current] * this.margin;
    if (!clearlyBetter) {
      this.candidate = -1;
      return -1;
    }
    if (this.candidate !== index) {
      this.candidate = index;
      this.since = now;
      return -1;
    }
    if (now - this.since >= this.dwell) {
      this.current = index;
      this.candidate = -1;
      return index;
    }
    return -1;
  }

  /** Call when focus moved by other means (a click), so we agree with reality. */
  reset(index = -1) {
    this.current = index;
    this.candidate = -1;
  }
}
