// The indicator window. It hosts the tracker and shows what it's doing in one line.
import { call, listen, native } from './api.js';
import { Tracker, cameraSource, pointerSource } from './tracker.js';
import { save } from './prefs.js';

const pill = document.getElementById('pill');
const label = document.getElementById('label');
const sub = document.getElementById('sub');
const video = document.getElementById('cam');
const params = new URLSearchParams(location.search);

const TEXT = {
  starting: ['Starting', 'opening the camera'],
  paused: ['Paused', 'Alt Shift G resumes'],
  nocamera: ['No camera', 'click for help'],
  uncalibrated: ['Calibrate me', 'click to start'],
  calibrating: ['Calibrating', 'follow the dot'],
  noface: ['No face', 'look at a screen'],
  holding: ['Typing', 'will switch after'],
};

function render(s) {
  pill.dataset.status = s.status;
  const name = (i) => (i >= 0 && s.screens[i] ? `Screen ${i + 1}` : '');
  if (s.status === 'tracking') {
    label.textContent = name(s.looking) || 'Tracking';
    sub.textContent = s.screens[s.looking] ? s.screens[s.looking].name : '';
  } else if (s.status === 'holding') {
    label.textContent = 'Typing';
    sub.textContent = `then ${name(s.looking)}`;
  } else {
    [label.textContent, sub.textContent] = TEXT[s.status] || [s.status, ''];
  }
}

const tracker = new Tracker({
  makeSource: () => (native || params.has('camera') ? cameraSource(video) : pointerSource()),
  onState: render,
});
window.__glance = tracker; // handy for tests and the browser console

pill.addEventListener('click', () => {
  if (!native) return;
  if (tracker.status === 'tracking' && !tracker.centers) tracker.startCalibration();
  else call('open_settings');
});

listen('glance://prefs', (p) => tracker.setPrefs(p));
listen('glance://toggle-pause', () => {
  const next = { ...tracker.prefs, enabled: !tracker.prefs.enabled };
  save(next);
  tracker.setPrefs(next);
});
listen('glance://start-calibration', () => tracker.startCalibration());
listen('glance://calib-capture', () => tracker.capture());
listen('glance://calib-cancel', () => tracker.cancelCalibration());
listen('glance://retry', () => tracker.start());
listen('glance://ask-state', () => tracker.publish(true));

if (native) call('place_pill', { visible: tracker.prefs.showPill });
tracker.start();
