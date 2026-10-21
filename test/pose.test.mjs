import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headPose, smooth, centroid, nearest, Switcher } from '../src/js/pose.js';

// A minimal face: only the five landmarks headPose reads are meaningful.
function face({ nose = 0.5, noseY = 0.5 } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  lm[1] = { x: nose, y: noseY, z: 0 };
  lm[234] = { x: 0.3, y: 0.5, z: 0 };
  lm[454] = { x: 0.7, y: 0.5, z: 0 };
  lm[10] = { x: 0.5, y: 0.2, z: 0 };
  lm[152] = { x: 0.5, y: 0.8, z: 0 };
  return lm;
}

test('a straight-on face has no yaw or pitch', () => {
  const p = headPose(face());
  assert.ok(Math.abs(p.yaw) < 1e-9 && Math.abs(p.pitch) < 1e-9);
});

test('turning moves yaw in a consistent direction', () => {
  assert.ok(headPose(face({ nose: 0.6 })).yaw > 0.3);
  assert.ok(headPose(face({ nose: 0.4 })).yaw < -0.3);
  assert.ok(headPose(face({ noseY: 0.6 })).pitch > 0.2);
});

test('no face or a broken one gives null', () => {
  assert.equal(headPose(null), null);
  assert.equal(headPose([]), null);
});

test('smoothing eases toward the new reading', () => {
  const s = smooth({ yaw: 0, pitch: 0 }, { yaw: 1, pitch: -1, size: 0.2 }, 0.5);
  assert.deepEqual(s, { yaw: 0.5, pitch: -0.5, size: 0.2 });
  assert.equal(smooth(null, { yaw: 1, pitch: 1 }).yaw, 1);
});

test('calibration centroid ignores outliers', () => {
  const samples = [...Array(18).fill({ yaw: 0.4, pitch: 0 }), { yaw: 5, pitch: 5 }, { yaw: -5, pitch: -5 }];
  const c = centroid(samples);
  assert.ok(Math.abs(c.yaw - 0.4) < 1e-9 && Math.abs(c.pitch) < 1e-9);
  assert.equal(centroid([]), null);
});

const SCREENS = [{ center: { yaw: -0.4, pitch: 0 } }, { center: { yaw: 0.4, pitch: 0 } }];

test('nearest picks the closest calibrated screen', () => {
  assert.equal(nearest({ yaw: 0.3, pitch: 0.1 }, SCREENS).index, 1);
  assert.equal(nearest({ yaw: -0.5, pitch: 0 }, SCREENS).index, 0);
  assert.equal(nearest({ yaw: 0, pitch: 0 }, []).index, -1);
});

test('the switcher waits for the dwell time before switching', () => {
  const sw = new Switcher({ dwell: 300 });
  assert.equal(sw.update({ yaw: -0.4, pitch: 0 }, SCREENS, 0), -1); // learns screen 0
  assert.equal(sw.update({ yaw: 0.4, pitch: 0 }, SCREENS, 100), -1); // candidate
  assert.equal(sw.update({ yaw: 0.4, pitch: 0 }, SCREENS, 300), -1); // not long enough
  assert.equal(sw.update({ yaw: 0.4, pitch: 0 }, SCREENS, 401), 1);
  assert.equal(sw.update({ yaw: 0.4, pitch: 0 }, SCREENS, 900), -1); // already there
});

test('a quick glance away does not switch', () => {
  const sw = new Switcher({ dwell: 300 });
  sw.update({ yaw: -0.4, pitch: 0 }, SCREENS, 0);
  sw.update({ yaw: 0.4, pitch: 0 }, SCREENS, 100);
  sw.update({ yaw: -0.4, pitch: 0 }, SCREENS, 200); // looked back
  assert.equal(sw.update({ yaw: 0.4, pitch: 0 }, SCREENS, 450), -1); // the clock restarted
});

test('looking at the gap between screens does not flip-flop', () => {
  const sw = new Switcher({ dwell: 0, margin: 0.8 });
  sw.update({ yaw: -0.4, pitch: 0 }, SCREENS, 0);
  // Just past the middle is closer to screen 1, but not clearly closer.
  for (let t = 1; t < 10; t++) assert.equal(sw.update({ yaw: 0.02, pitch: 0 }, SCREENS, t * 100), -1);
});
