// Chipper UI helper: keeps each slider's filled part in step with its value.
// A slider with an id also updates <output for="id">, formatted by data-format:
// "pct" (0..1 as a percentage), "px", "ms", "x" (a multiplier), or a unit word.
const FORMATS = {
  pct: (v) => `${Math.round(v * 100)}%`,
  px: (v) => `${Math.round(v)} px`,
  ms: (v) => `${Math.round(v)} ms`,
  x: (v) => `${v.toFixed(1)}×`,
};
const paint = (r) => {
  const min = Number(r.min || 0), max = Number(r.max || 100), v = Number(r.value);
  const fill = `${((v - min) / (max - min || 1)) * 100}%`;
  if (r.style.getPropertyValue('--fill') !== fill) r.style.setProperty('--fill', fill);
  if (r.id) {
    const out = document.querySelector(`output[for="${r.id}"]`);
    const f = r.dataset.format;
    const text = FORMATS[f] ? FORMATS[f](v) : f ? `${v} ${f}` : String(v);
    // Only touch the text when it changes, so the observer below doesn't loop.
    if (out && out.textContent !== text) out.textContent = text;
  }
};
const all = () => document.querySelectorAll('input[type=range]').forEach(paint);
document.addEventListener('input', (e) => { if (e.target.matches?.('input[type=range]')) paint(e.target); });
// Values set from script don't fire events, so catch those too.
const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
Object.defineProperty(HTMLInputElement.prototype, 'value', {
  ...desc,
  set(v) { desc.set.call(this, v); if (this.type === 'range') paint(this); },
});
new MutationObserver(all).observe(document.documentElement, { subtree: true, childList: true });
addEventListener('DOMContentLoaded', all);
all();
