//! Moving keyboard focus to the front-most window on a given screen, and reading how
//! long ago the user last typed or moved the mouse. One implementation per system.

/// A screen's rectangle in physical pixels, plus its scale factor.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Screen {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub scale: f64,
}

impl Screen {
    pub fn contains(&self, px: f64, py: f64) -> bool {
        px >= self.x && px < self.x + self.w && py >= self.y && py < self.y + self.h
    }

    /// The same rectangle in logical points (what macOS uses for window bounds).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    pub fn in_points(&self) -> Screen {
        let s = if self.scale > 0.0 { self.scale } else { 1.0 };
        Screen { x: self.x / s, y: self.y / s, w: self.w / s, h: self.h / s, scale: 1.0 }
    }
}

/// True when a window's center sits on the screen. Windows that straddle two screens
/// belong to the one holding their middle.
pub fn center_on(screen: &Screen, x: f64, y: f64, w: f64, h: f64) -> bool {
    w > 0.0 && h > 0.0 && screen.contains(x + w / 2.0, y + h / 2.0)
}

pub use imp::{focus_topmost_on, idle_ms};

#[cfg(target_os = "windows")]
mod imp {
    use super::{center_on, Screen};
    use windows::Win32::Foundation::{HWND, LPARAM, RECT};
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
    use windows::Win32::System::SystemInformation::GetTickCount;
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    use windows::Win32::UI::WindowsAndMessaging::{
        BringWindowToTop, EnumWindows, GetForegroundWindow, GetWindowLongW, GetWindowRect, GetWindowTextLengthW,
        GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, GWL_EXSTYLE, WS_EX_NOACTIVATE,
        WS_EX_TOOLWINDOW,
    };
    use windows::core::BOOL;

    unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let list = &mut *(lparam.0 as *mut Vec<HWND>);
        list.push(hwnd);
        BOOL(1)
    }

    pub fn focus_topmost_on(screen: &Screen) -> Result<bool, String> {
        unsafe {
            // EnumWindows lists top-level windows front to back.
            let mut list: Vec<HWND> = Vec::new();
            EnumWindows(Some(collect), LPARAM(&mut list as *mut Vec<HWND> as isize)).map_err(|e| e.to_string())?;
            let me = GetCurrentProcessId();
            for hwnd in list {
                if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                    continue;
                }
                let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
                if ex & WS_EX_TOOLWINDOW.0 != 0 || ex & WS_EX_NOACTIVATE.0 != 0 || GetWindowTextLengthW(hwnd) == 0 {
                    continue;
                }
                let mut cloaked: u32 = 0;
                let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut _, 4);
                if cloaked != 0 {
                    continue;
                }
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if pid == me {
                    continue;
                }
                let mut r = RECT::default();
                if GetWindowRect(hwnd, &mut r).is_err() {
                    continue;
                }
                let (x, y, w, h) = (r.left as f64, r.top as f64, (r.right - r.left) as f64, (r.bottom - r.top) as f64);
                if !center_on(screen, x, y, w, h) {
                    continue;
                }
                let fg = GetForegroundWindow();
                if fg == hwnd {
                    return Ok(false);
                }
                // Windows only lets the app that owns the foreground hand it over, so
                // borrow its input queue for a moment.
                let fg_thread = GetWindowThreadProcessId(fg, None);
                let my_thread = GetCurrentThreadId();
                let attached = fg_thread != 0 && fg_thread != my_thread && AttachThreadInput(my_thread, fg_thread, true).as_bool();
                let _ = BringWindowToTop(hwnd);
                let ok = SetForegroundWindow(hwnd).as_bool();
                if attached {
                    let _ = AttachThreadInput(my_thread, fg_thread, false);
                }
                return Ok(ok);
            }
            Ok(false)
        }
    }

    pub fn idle_ms() -> u64 {
        unsafe {
            let mut info = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
            if !GetLastInputInfo(&mut info).as_bool() {
                return u64::MAX;
            }
            GetTickCount().wrapping_sub(info.dwTime) as u64
        }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{center_on, Screen};
    use core_foundation::array::{CFArray, CFArrayRef};
    use core_foundation::base::{CFType, TCFType};
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::number::CFNumber;
    use core_foundation::string::CFString;
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGWindowListCopyWindowInfo(option: u32, relative_to: u32) -> CFArrayRef;
        fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
    }

    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;

    fn number(d: &CFDictionary<CFString, CFType>, key: &str) -> Option<f64> {
        d.find(CFString::new(key)).and_then(|v| v.downcast::<CFNumber>()).and_then(|n| n.to_f64())
    }

    struct Win {
        pid: i32,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    /// On-screen app windows, front to back. Reading positions needs no permission.
    fn windows() -> Vec<Win> {
        let mut out = Vec::new();
        unsafe {
            let raw = CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0);
            if raw.is_null() {
                return out;
            }
            let list: CFArray<CFDictionary<CFString, CFType>> = CFArray::wrap_under_create_rule(raw);
            for d in list.iter() {
                if number(&d, "kCGWindowLayer").unwrap_or(1.0) != 0.0 || number(&d, "kCGWindowAlpha").unwrap_or(1.0) <= 0.0 {
                    continue;
                }
                let Some(pid) = number(&d, "kCGWindowOwnerPID") else { continue };
                let Some(bounds) = d.find(CFString::new("kCGWindowBounds")).and_then(|v| v.downcast::<CFDictionary>()) else { continue };
                let bounds: CFDictionary<CFString, CFType> = CFDictionary::wrap_under_get_rule(bounds.as_concrete_TypeRef());
                let (Some(x), Some(y), Some(w), Some(h)) =
                    (number(&bounds, "X"), number(&bounds, "Y"), number(&bounds, "Width"), number(&bounds, "Height"))
                else {
                    continue;
                };
                out.push(Win { pid: pid as i32, x, y, w, h });
            }
        }
        out
    }

    pub fn focus_topmost_on(screen: &Screen) -> Result<bool, String> {
        let screen = screen.in_points();
        let me = std::process::id() as i32;
        let Some(win) = windows().into_iter().find(|w| w.pid != me && w.w > 40.0 && w.h > 40.0 && center_on(&screen, w.x, w.y, w.w, w.h)) else {
            return Ok(false);
        };
        #[allow(unused_unsafe)]
        unsafe {
            let front = NSWorkspace::sharedWorkspace().frontmostApplication().map(|a| a.processIdentifier());
            if front == Some(win.pid) {
                return Ok(false);
            }
            let Some(app) = NSRunningApplication::runningApplicationWithProcessIdentifier(win.pid) else { return Ok(false) };
            Ok(app.activateWithOptions(NSApplicationActivationOptions::empty()))
        }
    }

    pub fn idle_ms() -> u64 {
        // Combined session state, any input event.
        let secs = unsafe { CGEventSourceSecondsSinceLastEventType(0, u32::MAX) };
        if secs.is_finite() && secs >= 0.0 { (secs * 1000.0) as u64 } else { u64::MAX }
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
mod imp {
    //! X11 through the window manager's EWMH hints. Wayland doesn't let apps see or
    //! focus other apps' windows, so there this quietly does nothing.
    use super::{center_on, Screen};
    use x11rb::connection::Connection;
    use x11rb::protocol::screensaver::ConnectionExt as _;
    use x11rb::protocol::xproto::{AtomEnum, ClientMessageEvent, ConnectionExt as _, EventMask, Window};

    fn atom(c: &impl Connection, name: &str) -> Option<u32> {
        Some(c.intern_atom(false, name.as_bytes()).ok()?.reply().ok()?.atom)
    }

    fn prop32(c: &impl Connection, w: Window, prop: u32, ty: u32) -> Vec<u32> {
        c.get_property(false, w, prop, ty, 0, 4096)
            .ok()
            .and_then(|r| r.reply().ok())
            .and_then(|r| r.value32().map(|v| v.collect()))
            .unwrap_or_default()
    }

    pub fn focus_topmost_on(screen: &Screen) -> Result<bool, String> {
        let (c, n) = x11rb::connect(None).map_err(|e| e.to_string())?;
        let root = c.setup().roots[n].root;
        let (Some(stacking), Some(active), Some(wm_pid), Some(state), Some(hidden)) = (
            atom(&c, "_NET_CLIENT_LIST_STACKING"),
            atom(&c, "_NET_ACTIVE_WINDOW"),
            atom(&c, "_NET_WM_PID"),
            atom(&c, "_NET_WM_STATE"),
            atom(&c, "_NET_WM_STATE_HIDDEN"),
        ) else {
            return Ok(false);
        };
        let me = std::process::id();
        let current = prop32(&c, root, active, AtomEnum::WINDOW.into()).first().copied().unwrap_or(0);
        // The stacking list runs bottom to top.
        for w in prop32(&c, root, stacking, AtomEnum::WINDOW.into()).into_iter().rev() {
            if prop32(&c, w, wm_pid, AtomEnum::CARDINAL.into()).first() == Some(&me) {
                continue;
            }
            if prop32(&c, w, state, AtomEnum::ATOM.into()).contains(&hidden) {
                continue;
            }
            let Ok(Ok(geo)) = c.get_geometry(w).map(|r| r.reply()) else { continue };
            let Ok(Ok(pos)) = c.translate_coordinates(w, root, 0, 0).map(|r| r.reply()) else { continue };
            if !center_on(screen, pos.dst_x as f64, pos.dst_y as f64, geo.width as f64, geo.height as f64) {
                continue;
            }
            if w == current {
                return Ok(false);
            }
            // Source 2 means "a pager or similar tool", which window managers honor.
            let event = ClientMessageEvent::new(32, w, active, [2, 0, current, 0, 0]);
            c.send_event(false, root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, event)
                .map_err(|e| e.to_string())?;
            c.flush().map_err(|e| e.to_string())?;
            return Ok(true);
        }
        Ok(false)
    }

    pub fn idle_ms() -> u64 {
        let read = || -> Option<u64> {
            let (c, n) = x11rb::connect(None).ok()?;
            let root = c.setup().roots[n].root;
            let ms = c.screensaver_query_info(root).ok()?.reply().ok()?.ms_since_user_input as u64;
            Some(ms)
        };
        read().unwrap_or(u64::MAX)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_belong_to_the_screen_holding_their_middle() {
        let left = Screen { x: 0.0, y: 0.0, w: 1920.0, h: 1080.0, scale: 1.0 };
        let right = Screen { x: 1920.0, y: 0.0, w: 2560.0, h: 1440.0, scale: 1.0 };
        assert!(center_on(&left, 1500.0, 100.0, 600.0, 400.0)); // middle at 1800
        assert!(!center_on(&right, 1500.0, 100.0, 600.0, 400.0));
        assert!(center_on(&right, 1800.0, 100.0, 600.0, 400.0)); // middle at 2100
        assert!(!center_on(&left, 10.0, 10.0, 0.0, 0.0));
    }

    #[test]
    fn converts_screens_to_points() {
        let s = Screen { x: 2880.0, y: 0.0, w: 3024.0, h: 1964.0, scale: 2.0 };
        assert_eq!(s.in_points(), Screen { x: 1440.0, y: 0.0, w: 1512.0, h: 982.0, scale: 1.0 });
    }
}
