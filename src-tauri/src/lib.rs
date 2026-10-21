//! Glance: the camera sees which screen you're facing and keyboard focus follows.
//! Face tracking runs in the small indicator window's webview (MediaPipe, on device);
//! this side lists screens, moves focus and reports how long since you last typed.

mod focus;

use focus::Screen;
use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::ShortcutState;

const PAUSE_SHORTCUT: &str = "Alt+Shift+G";
const PILL: (f64, f64) = (196.0, 40.0);

#[derive(Serialize, Clone)]
struct ScreenInfo {
    index: usize,
    name: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    scale: f64,
    primary: bool,
}

fn screen_list(app: &AppHandle) -> Vec<ScreenInfo> {
    let primary = app.primary_monitor().ok().flatten().map(|m| (m.position().x, m.position().y));
    let mut list: Vec<ScreenInfo> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .enumerate()
        .map(|(i, m)| ScreenInfo {
            index: i,
            name: m.name().cloned().unwrap_or_else(|| format!("Screen {}", i + 1)),
            x: m.position().x as f64,
            y: m.position().y as f64,
            w: m.size().width as f64,
            h: m.size().height as f64,
            scale: m.scale_factor(),
            primary: primary == Some((m.position().x, m.position().y)),
        })
        .collect();
    // Left to right, so "Screen 1" is the leftmost one.
    list.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap().then(a.y.partial_cmp(&b.y).unwrap()));
    for (i, s) in list.iter_mut().enumerate() {
        s.index = i;
    }
    list
}

#[tauri::command]
fn screens(app: AppHandle) -> Vec<ScreenInfo> {
    screen_list(&app)
}

/// Moves keyboard focus to the front-most window on a screen, and optionally the
/// mouse pointer to that screen's middle.
#[tauri::command]
fn focus_screen(app: AppHandle, index: usize, move_pointer: bool) -> Result<bool, String> {
    let list = screen_list(&app);
    let s = list.get(index).ok_or("that screen isn't connected")?;
    let screen = Screen { x: s.x, y: s.y, w: s.w, h: s.h, scale: s.scale };
    if move_pointer {
        if let Some(win) = app.get_webview_window("pill") {
            if let Ok(origin) = win.inner_position() {
                let _ = win.set_cursor_position(PhysicalPosition::new(
                    s.x + s.w / 2.0 - origin.x as f64,
                    s.y + s.h / 2.0 - origin.y as f64,
                ));
            }
        }
    }
    focus::focus_topmost_on(&screen)
}

#[tauri::command]
fn idle_ms() -> u64 {
    focus::idle_ms()
}

/// Shows the calibration dot full screen on one screen.
#[tauri::command]
fn open_calibration(app: AppHandle, index: usize) -> Result<(), String> {
    let list = screen_list(&app);
    let s = list.get(index).ok_or("that screen isn't connected")?.clone();
    let win = match app.get_webview_window("calibrate") {
        Some(w) => w,
        None => WebviewWindowBuilder::new(&app, "calibrate", WebviewUrl::App("calibrate.html".into()))
            .title("Glance calibration")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?,
    };
    let _ = win.set_position(LogicalPosition::new(s.x / s.scale, s.y / s.scale));
    let _ = win.set_size(LogicalSize::new(s.w / s.scale, s.h / s.scale));
    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit_to("calibrate", "glance://calibrate-screen", (index, list.len()));
    Ok(())
}

#[tauri::command]
fn close_calibration(app: AppHandle) {
    if let Some(win) = app.get_webview_window("calibrate") {
        let _ = win.close();
    }
}

#[tauri::command]
fn open_settings(app: AppHandle) {
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(&app, "settings", WebviewUrl::App("settings.html".into()))
        .title("Glance")
        .inner_size(760.0, 680.0)
        .min_inner_size(560.0, 520.0)
        .center()
        .build();
}

/// The indicator pill sits in the bottom-right corner. "Hidden" shrinks it to a dot
/// instead of hiding it, because a hidden webview may stop running the camera.
#[tauri::command]
fn place_pill(app: AppHandle, visible: bool) {
    let Some(win) = app.get_webview_window("pill") else { return };
    let Some(m) = win.primary_monitor().ok().flatten() else { return };
    let scale = m.scale_factor();
    let area = m.work_area();
    let (w, h) = if visible { PILL } else { (2.0, 2.0) };
    let x = (area.position.x as f64 + area.size.width as f64) / scale - w - 14.0;
    let y = (area.position.y as f64 + area.size.height as f64) / scale - h - 14.0;
    let _ = win.set_size(LogicalSize::new(w, h));
    let _ = win.set_position(LogicalPosition::new(x, y));
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// WebKitGTK keeps the camera off unless the app turns it on and answers its prompt.
#[cfg(all(unix, not(target_os = "macos")))]
fn allow_camera(win: &WebviewWindow) {
    let _ = win.with_webview(|wv| {
        use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
        let view = wv.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_media_stream(true);
        }
        view.connect_permission_request(|_, request| {
            request.allow();
            true
        });
    });
}

#[cfg(not(all(unix, not(target_os = "macos"))))]
fn allow_camera(_win: &WebviewWindow) {}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| open_settings(app.clone())))
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcuts([PAUSE_SHORTCUT])
                .expect("valid shortcut")
                .with_handler(|app, _, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("glance://toggle-pause", ());
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            screens,
            focus_screen,
            idle_ms,
            open_calibration,
            close_calibration,
            open_settings,
            place_pill,
            quit
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let handle = app.handle().clone();

            let pill = WebviewWindowBuilder::new(app, "pill", WebviewUrl::App("index.html".into()))
                .title("Glance")
                .inner_size(PILL.0, PILL.1)
                .decorations(false)
                .transparent(true)
                .always_on_top(true)
                .skip_taskbar(true)
                .shadow(false)
                .min_inner_size(2.0, 2.0)
                .focused(false)
                .visible_on_all_workspaces(true)
                .build()?;
            allow_camera(&pill);
            place_pill(handle.clone(), true);

            let pause = MenuItem::with_id(app, "pause", "Pause or resume (Alt Shift G)", true, None::<&str>)?;
            let calibrate = MenuItem::with_id(app, "calibrate", "Calibrate…", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Glance", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&pause, &calibrate, &settings, &sep, &quit])?;
            TrayIconBuilder::new()
                .icon(app.default_window_icon().cloned().expect("app icon"))
                .tooltip("Glance")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "pause" => {
                        let _ = app.emit("glance://toggle-pause", ());
                    }
                    "calibrate" => {
                        let _ = app.emit("glance://start-calibration", ());
                    }
                    "settings" => open_settings(app.clone()),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        open_settings(tray.app_handle().clone());
                    }
                })
                .build(app)?;

            let first = handle.path().app_config_dir().map(|d| d.join("launched")).ok();
            if let Some(marker) = first {
                if !marker.exists() {
                    let _ = std::fs::create_dir_all(marker.parent().unwrap());
                    let _ = std::fs::write(&marker, b"1");
                    open_settings(handle);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Glance");
}
