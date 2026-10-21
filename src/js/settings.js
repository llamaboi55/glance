// The settings window: live status, the screen map and options.
import { autostart, call, emit, listen, native } from './api.js';
import { load, save, saveCalibration } from './prefs.js';
import { Tracker, pointerSource, PREVIEW_SCREENS } from './tracker.js';

const $ = (id) => document.getElementById(id);
let prefs = load();

const CHIP = {
  starting: 'Starting',
  tracking: 'Watching',
  holding: 'Waiting for typing to stop',
  noface: "Can't see you",
  paused: 'Paused',
  nocamera: 'No camera',
  uncalibrated: 'Needs calibrating',
  calibrating: 'Calibrating',
};

// ---------- Options
function fmtMs(v) {
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)} s` : `${v} ms`;
}
function showPrefs() {
  $('enabled').checked = prefs.enabled;
  for (const id of ['movePointer', 'showPill']) $(id).checked = prefs[id];
  for (const id of ['dwell', 'typingDelay']) {
    $(id).value = prefs[id];
    $(`${id}-out`).textContent = fmtMs(prefs[id]);
  }
}
function change(patch) {
  prefs = { ...prefs, ...patch };
  save(prefs);
  showPrefs();
  if (preview) preview.setPrefs(prefs);
}
$('enabled').addEventListener('change', (e) => change({ enabled: e.target.checked }));
for (const id of ['movePointer', 'showPill']) $(id).addEventListener('change', (e) => change({ [id]: e.target.checked }));
for (const id of ['dwell', 'typingDelay']) $(id).addEventListener('input', (e) => change({ [id]: Number(e.target.value) }));
$('autostart').addEventListener('change', (e) => autostart.set(e.target.checked).catch(() => (e.target.checked = !e.target.checked)));
autostart.isEnabled().then((on) => ($('autostart').checked = on)).catch(() => {});
$('calibrate').addEventListener('click', () => (preview ? previewCalibrate() : emit('glance://start-calibration')));
$('retry').addEventListener('click', () => emit('glance://retry'));
$('quit').addEventListener('click', () => call('quit'));
listen('glance://prefs', (p) => {
  prefs = p;
  showPrefs();
});
showPrefs();

// ---------- Live status
function render(s) {
  const chip = $('chip');
  chip.dataset.status = s.status;
  chip.textContent = CHIP[s.status] || s.status;
  $('banner').hidden = s.status !== 'nocamera';
  $('banner-text').textContent = s.error;
  $('warning').hidden = !s.warning;
  $('warning').textContent = s.warning;
  const cal = $('calibrate');
  cal.classList.toggle('primary', !s.calibrated);
  cal.textContent = s.calibrated ? 'Calibrate again' : 'Calibrate';
  cal.disabled = s.status === 'paused' || s.status === 'nocamera' || s.status === 'calibrating';
  $('screens-note').textContent =
    s.screens.length < 2
      ? 'Glance is made for two or more screens. Plug another one in and it shows up here.'
      : !s.calibrated
        ? 'Calibrate once so Glance learns which way you turn for each screen. It takes about ten seconds.'
        : "The highlighted screen is the one you're facing. The keyboard shows where typing goes.";
  drawMap(s);
  drawPad(s);
}

function drawMap(s) {
  const map = $('map');
  const list = s.screens;
  if (!list.length) return (map.innerHTML = '');
  const minX = Math.min(...list.map((d) => d.x));
  const minY = Math.min(...list.map((d) => d.y));
  const maxX = Math.max(...list.map((d) => d.x + d.w));
  const maxY = Math.max(...list.map((d) => d.y + d.h));
  const k = Math.min((map.clientWidth - 8) / (maxX - minX), (map.clientHeight - 8) / (maxY - minY));
  const ox = (map.clientWidth - (maxX - minX) * k) / 2;
  const oy = (map.clientHeight - (maxY - minY) * k) / 2;
  if (map.children.length !== list.length) map.innerHTML = list.map(() => '<div class="screen"><b></b><small></small><i class="kb">⌨</i></div>').join('');
  list.forEach((d, i) => {
    const el = map.children[i];
    Object.assign(el.style, { left: `${ox + (d.x - minX) * k + 3}px`, top: `${oy + (d.y - minY) * k + 3}px`, width: `${d.w * k - 6}px`, height: `${d.h * k - 6}px` });
    el.querySelector('b').textContent = `Screen ${i + 1}`;
    el.querySelector('small').textContent = d.name;
    el.classList.toggle('looking', s.looking === i && Boolean(s.pose));
    el.classList.toggle('focused', s.focused === i);
  });
}

// Head direction plotted with each screen's calibrated spot, mirrored if needed so
// left on the pad is the left screen.
function drawPad(s) {
  const pad = $('pad');
  const W = pad.clientWidth;
  const H = pad.clientHeight;
  const flip = s.centers.length > 1 && s.centers[0].yaw > s.centers[s.centers.length - 1].yaw ? -1 : 1;
  const spread = Math.max(0.35, ...s.centers.map((c) => Math.abs(c.yaw) + 0.15));
  const at = (p) => [W / 2 + ((flip * p.yaw) / spread) * (W / 2 - 14), H / 2 + (p.pitch / spread) * (H / 2 - 14)];
  $('pad-centers').innerHTML = s.centers
    .map((c, i) => {
      const [x, y] = at(c);
      return `<span class="center${s.looking === i && s.pose ? ' on' : ''}" style="left:${x}px;top:${y}px">${i + 1}</span>`;
    })
    .join('');
  const you = $('you');
  you.hidden = !s.pose;
  if (s.pose) {
    const [x, y] = at(s.pose);
    you.style.transform = `translate(${Math.max(8, Math.min(W - 8, x))}px, ${Math.max(8, Math.min(H - 8, y))}px)`;
  }
}

// ---------- Native: the tracker lives in the indicator window, we just listen.
let preview = null;
if (native) {
  listen('glance://state', render);
  emit('glance://ask-state');
} else {
  // Browser preview: run a tracker right here, with the mouse over the pad as your head.
  document.documentElement.classList.add('preview');
  if (!localStorage.getItem('glance:calibration'))
    saveCalibration(PREVIEW_SCREENS, [
      { yaw: -0.5, pitch: 0.15 },
      { yaw: 0.45, pitch: -0.2 },
    ]);
  const source = pointerSource($('pad'), 0.65);
  preview = new Tracker({ makeSource: async () => source, onState: render });
  window.__glance = preview;
  window.__glanceSource = source;
  preview.start();
}

function previewCalibrate() {
  $('screens-note').textContent = 'In the app, a dot appears on each screen in turn. You look at it and press Space, and that is it.';
}
