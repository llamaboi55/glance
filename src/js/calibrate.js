// The full-screen dot shown on each screen in turn during calibration.
import { emit, listen, native } from './api.js';

const step = document.getElementById('step');
const title = document.getElementById('title');
const hint = document.getElementById('hint');
const error = document.getElementById('error');
const ring = document.getElementById('ring');
const target = document.getElementById('target');

function render(c) {
  if (!c) return;
  step.textContent = `Screen ${c.index + 1} of ${c.count}`;
  document.body.classList.toggle('sampling', c.sampling);
  ring.style.strokeDashoffset = String(100 - c.progress * 100);
  title.textContent = c.sampling ? 'Hold still…' : 'Look at the dot';
  hint.hidden = c.sampling;
  error.hidden = !c.error;
  error.textContent = c.error;
}

const capture = () => emit('glance://calib-capture');
target.addEventListener('click', capture);
document.addEventListener('keydown', (e) => {
  if (e.key === ' ' || e.key === 'Enter') {
    e.preventDefault();
    capture();
  } else if (e.key === 'Escape') emit('glance://calib-cancel');
});

listen('glance://state', (s) => render(s.calib));
emit('glance://ask-state');

if (!native) {
  const p = new URLSearchParams(location.search);
  render({ index: Number(p.get('index') || 0), count: 2, sampling: p.has('sampling'), progress: Number(p.get('progress') || 0.6), error: '' });
}
