// Thin wrapper over Tauri so the same pages also run in a normal browser for previews.
const T = window.__TAURI__;
export const native = Boolean(T);

export async function call(cmd, args = {}) {
  if (!native) return null;
  return T.core.invoke(cmd, args);
}

export function listen(event, fn) {
  if (!native) return () => {};
  let off = () => {};
  T.event.listen(event, (e) => fn(e.payload)).then((u) => (off = u));
  return () => off();
}

export function emit(event, payload) {
  if (native) T.event.emit(event, payload);
}

export function currentWindow() {
  return native ? T.window.getCurrentWindow() : null;
}

export const autostart = {
  async isEnabled() {
    return native ? T.core.invoke('plugin:autostart|is_enabled') : false;
  },
  async set(on) {
    if (native) await T.core.invoke(on ? 'plugin:autostart|enable' : 'plugin:autostart|disable');
  },
};
