// The tracker: reads head direction from the camera, works out which screen you're
// facing and moves keyboard focus there. It runs inside the small indicator window,
// which stays visible so the system never pauses its timers.
import { call, emit, native } from './api.js';
import { headPose, smooth, centroid, distance, nearest, Switcher } from './pose.js';
import { load, loadCalibration, saveCalibration } from './prefs.js';

const SAMPLE_MS = 1500;
const MIN_SAMPLES = 8;
const LOST_AFTER = 600;

// What the browser preview pretends is plugged in.
export const PREVIEW_SCREENS = [
  { index: 0, name: 'Laptop', x: 0, y: 360, w: 1920, h: 1080, scale: 1, primary: true },
  { index: 1, name: 'Monitor', x: 1920, y: 0, w: 2560, h: 1440, scale: 1, primary: false },
];

/** Camera frames through MediaPipe's face landmarker, all on this computer. */
let landmarker = null;
export async function cameraSource(video) {
  if (!landmarker) {
    const { FilesetResolver, FaceLandmarker } = await import('../vendor/mediapipe/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks(new URL('../vendor/mediapipe/wasm', import.meta.url).href);
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('../models/face_landmarker.task', import.meta.url).href, delegate: 'CPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
    });
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
    audio: false,
  });
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  let last = -1;
  return {
    read(now) {
      if (video.readyState < 2 || video.currentTime === last) return undefined; // no new frame yet
      last = video.currentTime;
      const r = landmarker.detectForVideo(video, now);
      return r.faceLandmarks && r.faceLandmarks[0] ? headPose(r.faceLandmarks[0]) : null;
    },
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

/** For the preview: the mouse plays the part of your head. */
export function pointerSource(target = window, scale = 1) {
  let pose = null;
  const move = (e) => {
    const r = target === window ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : target.getBoundingClientRect();
    pose = { yaw: (((e.clientX - r.left) / r.width) * 2 - 1) * scale, pitch: (((e.clientY - r.top) / r.height) * 2 - 1) * scale, size: 0.3 };
  };
  const leave = () => (pose = null);
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerleave', leave);
  return {
    read: () => (pose ? { ...pose } : null),
    stop() {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerleave', leave);
    },
    set(p) {
      pose = p;
    },
  };
}

let lastInput = 0;
if (!native) {
  for (const ev of ['keydown', 'pointerdown']) addEventListener(ev, () => (lastInput = performance.now()), true);
}
async function idleMs() {
  if (native) return (await call('idle_ms')) ?? Infinity;
  return performance.now() - lastInput;
}

async function listScreens() {
  if (!native) return PREVIEW_SCREENS;
  return (await call('screens')) || [];
}

export class Tracker {
  /**
   * @param makeSource async () => {read(now), stop()}; read returns a pose, null (no
   *   face) or undefined (no new frame).
   */
  constructor({ makeSource, onState = () => {} }) {
    this.makeSource = makeSource;
    this.onState = onState;
    this.prefs = load();
    this.source = null;
    this.status = 'starting';
    this.error = '';
    this.screens = [];
    this.centers = null;
    this.pose = null;
    this.lastFace = 0;
    this.looking = -1;
    this.focused = -1;
    this.pending = -1;
    this.holding = false;
    this.switches = 0;
    this.calib = null;
    this.timer = 0;
    this.lastPublish = 0;
    this.lastScreens = 0;
    this.switcher = new Switcher({ dwell: this.prefs.dwell });
  }

  async refreshScreens() {
    this.screens = await listScreens();
    this.centers = loadCalibration(this.screens);
    if (!this.centers || this.centers.length !== this.screens.length) this.centers = null;
    this.lastScreens = performance.now();
  }

  setPrefs(prefs) {
    const wasEnabled = this.prefs.enabled;
    this.prefs = prefs;
    this.switcher.dwell = prefs.dwell;
    if (prefs.enabled !== wasEnabled) prefs.enabled ? this.start() : this.stop('paused');
    if (native) call('place_pill', { visible: prefs.showPill });
  }

  async start() {
    if (this.source) return;
    await this.refreshScreens();
    if (!this.prefs.enabled) return this.stop('paused');
    this.status = 'starting';
    this.error = '';
    this.publish(true);
    try {
      this.source = await this.makeSource();
    } catch (e) {
      this.status = 'nocamera';
      this.error = cameraError(e);
      this.publish(true);
      return;
    }
    this.switcher.reset();
    this.focused = -1;
    this.pose = null;
    this.status = 'tracking';
    this.loop();
  }

  stop(status = 'paused') {
    clearTimeout(this.timer);
    this.timer = 0;
    if (this.source) this.source.stop();
    this.source = null;
    this.pose = null;
    this.pending = -1;
    this.status = status;
    this.publish(true);
  }

  loop() {
    const tick = async () => {
      if (!this.source) return;
      const now = performance.now();
      let raw;
      try {
        raw = this.source.read(now);
      } catch {
        raw = null;
      }
      if (raw) {
        this.pose = smooth(this.pose, raw);
        this.lastFace = now;
      } else if (raw === null && now - this.lastFace > LOST_AFTER) {
        this.pose = null;
      }
      if (now - this.lastScreens > 5000 && !this.calib) await this.refreshScreens();
      if (this.calib) this.calibrationStep(raw, now);
      else await this.decide(now);
      this.publish();
      if (this.source) this.timer = setTimeout(tick, 1000 / this.prefs.fps);
    };
    this.timer = setTimeout(tick, 0);
  }

  async decide(now) {
    this.holding = false;
    if (!this.pose || !this.centers) {
      this.looking = -1;
      return;
    }
    const n = nearest(this.pose, this.centers);
    this.looking = n.index;
    if (this.focused < 0) this.focused = n.index;
    const to = this.switcher.update(this.pose, this.centers, now);
    if (to >= 0 && to !== this.focused) this.pending = to;
    if (this.pending < 0) return;
    if (n.index !== this.pending) {
      // Looked back before focus moved: forget it and agree with where focus really is.
      this.pending = -1;
      this.switcher.reset(this.focused);
      return;
    }
    if ((await idleMs()) < this.prefs.typingDelay) {
      this.holding = true; // still typing: wait for a pause so no keystroke lands elsewhere
      return;
    }
    const target = this.pending;
    this.pending = -1;
    this.focused = target;
    this.switches++;
    try {
      await call('focus_screen', { index: target, movePointer: this.prefs.movePointer });
    } catch {}
  }

  // ---------- Calibration: look at each screen in turn while a dot is shown there.
  async startCalibration() {
    await this.refreshScreens();
    if (!this.source) await this.start();
    if (!this.source) return;
    this.calib = { index: 0, centers: [], samples: null, until: 0, progress: 0, error: '' };
    if (native) await call('open_calibration', { index: 0 });
    this.publish(true);
  }

  capture() {
    if (!this.calib || this.calib.samples) return;
    this.calib.samples = [];
    this.calib.until = performance.now() + SAMPLE_MS;
    this.calib.error = '';
  }

  cancelCalibration() {
    this.calib = null;
    if (native) call('close_calibration');
    this.publish(true);
  }

  calibrationStep(raw, now) {
    const c = this.calib;
    if (!c.samples) return;
    if (raw) c.samples.push(raw);
    c.progress = Math.min(1, 1 - (c.until - now) / SAMPLE_MS);
    if (now < c.until) return;
    if (c.samples.length < MIN_SAMPLES) {
      c.samples = null;
      c.progress = 0;
      c.error = "Couldn't see your face. Check the camera can see you, then try again.";
      return;
    }
    c.centers.push(centroid(c.samples));
    c.samples = null;
    c.progress = 0;
    c.index++;
    if (c.index < this.screens.length) {
      if (native) call('open_calibration', { index: c.index });
      return;
    }
    saveCalibration(this.screens, c.centers);
    this.centers = c.centers.map((center) => ({ center }));
    this.warning = closeScreens(c.centers);
    this.calib = null;
    this.switcher.reset();
    this.focused = -1;
    if (native) call('close_calibration');
  }

  state() {
    const status = this.calib ? 'calibrating' : this.source && !this.centers ? 'uncalibrated' : this.source && !this.pose ? 'noface' : this.holding ? 'holding' : this.status;
    return {
      status,
      error: this.error,
      warning: this.warning || '',
      screens: this.screens,
      calibrated: Boolean(this.centers),
      centers: this.centers ? this.centers.map((s) => s.center) : [],
      pose: this.pose,
      looking: this.looking,
      focused: this.focused,
      switches: this.switches,
      calib: this.calib && {
        index: this.calib.index,
        count: this.screens.length,
        sampling: Boolean(this.calib.samples),
        progress: this.calib.progress,
        error: this.calib.error,
      },
    };
  }

  publish(force = false) {
    const now = performance.now();
    if (!force && !this.calib && now - this.lastPublish < 200) return;
    this.lastPublish = now;
    const s = this.state();
    this.onState(s);
    emit('glance://state', s);
  }
}

function closeScreens(centers) {
  for (let i = 0; i < centers.length; i++)
    for (let j = i + 1; j < centers.length; j++)
      if (distance(centers[i], centers[j]) < 0.06)
        return `Screens ${i + 1} and ${j + 1} look almost the same from the camera. Turning your head a little more during calibration, or moving the camera between them, helps.`;
  return '';
}

function cameraError(e) {
  const name = e && e.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Camera access was turned down. Allow Glance to use the camera in your system settings, then press Try again.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera found. Plug one in, then press Try again.';
  if (name === 'NotReadableError') return 'Another app is using the camera. Close it, then press Try again.';
  return `The camera couldn't start (${(e && e.message) || e}).`;
}
