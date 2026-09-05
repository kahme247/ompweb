//! OS integration: tray icon with live session state, a Windows notification
//! when an agent run finishes while the window is unfocused, a global hotkey
//! (Alt+Shift+O) to toggle the window, and close-to-tray so quitting via the
//! tray is the one true exit. All plugin calls happen in Rust, so no
//! capability permissions are needed for them.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry, WindowEvent};

const HOTKEY: &str = "Alt+Shift+O";

pub struct ShellState {
    busy: AtomicBool,
    has_session: AtomicBool,
    notify_enabled: AtomicBool,
    close_to_tray: AtomicBool,
    tray: Mutex<Option<TrayIcon<Wry>>>,
    status_item: Mutex<Option<MenuItem<Wry>>>,
}

impl Default for ShellState {
    fn default() -> Self {
        Self {
            busy: AtomicBool::new(false),
            has_session: AtomicBool::new(false),
            notify_enabled: AtomicBool::new(true),
            close_to_tray: AtomicBool::new(true),
            tray: Mutex::new(None),
            status_item: Mutex::new(None),
        }
    }
}

/// Settings surface for the UI; keys are stable identifiers.
pub fn settings(app: &AppHandle) -> serde_json::Value {
    serde_json::json!({
        "notifyOnAgentEnd": app
            .try_state::<ShellState>()
            .map(|s| s.notify_enabled.load(Ordering::Relaxed))
            .unwrap_or(true),
        "closeToTray": app
            .try_state::<ShellState>()
            .map(|s| s.close_to_tray.load(Ordering::Relaxed))
            .unwrap_or(true),
    })
}

pub fn set_setting(app: &AppHandle, key: &str, value: bool) -> Result<(), String> {
    let Some(state) = app.try_state::<ShellState>() else {
        return Err("shell state unavailable".to_string());
    };
    match key {
        "notifyOnAgentEnd" => state.notify_enabled.store(value, Ordering::Relaxed),
        "closeToTray" => state.close_to_tray.store(value, Ordering::Relaxed),
        other => return Err(format!("unknown setting: {other}")),
    }
    Ok(())
}

fn status_label(has_session: bool, busy: bool, cwd: &str) -> String {
    if !has_session {
        return "No session".to_string();
    }
    let shown = if cwd.is_empty() { "…" } else { cwd };
    if busy {
        format!("Running — {shown}")
    } else {
        format!("Idle — {shown}")
    }
}

fn apply_status(state: &ShellState, label: &str, tooltip: &str) {
    if let Some(item) = state.status_item.lock().ok().and_then(|g| g.clone()) {
        let _ = item.set_text(label.to_string());
    }
    if let Some(tray) = state.tray.lock().ok().and_then(|g| g.clone()) {
        let _ = tray.set_tooltip(Some(tooltip.to_string()));
    }
}

/// Reader-thread hook: the omp child started or finished a run.
/// busy true→false while unfocused fires the completion notification.
pub fn report_agent_state(app: &AppHandle, busy: bool, cwd: &str) {
    let Some(state) = app.try_state::<ShellState>() else {
        return;
    };
    let was_busy = state.busy.swap(busy, Ordering::Relaxed);
    state.has_session.store(true, Ordering::Relaxed);
    let label = status_label(true, busy, cwd);
    let tooltip = if busy { "omp — running" } else { "omp — idle" };
    apply_status(&state, &label, tooltip);

    if was_busy && !busy {
        if !state.notify_enabled.load(Ordering::Relaxed) {
            return;
        }
        let focused = app
            .get_webview_window("main")
            .and_then(|w| w.is_focused().ok())
            .unwrap_or(true);
        if !focused {
            use tauri_plugin_notification::NotificationExt;
            let _ = app
                .notification()
                .builder()
                .title("omp task finished")
                .body("The agent run completed.")
                .show();
        }
    }
}

/// Exit-watcher hook: the omp child is gone; reset the tray without
/// notifying (the UI already surfaces the exit).
pub fn report_session_gone(app: &AppHandle) {
    if let Some(state) = app.try_state::<ShellState>() {
        state.busy.store(false, Ordering::Relaxed);
        state.has_session.store(false, Ordering::Relaxed);
        apply_status(&state, "No session", "omp");
    }
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
        } else {
            show_main_window(app);
        }
    }
}

fn stop_omp_session(app: &AppHandle) {
    if let Some(state) = app.try_state::<crate::omp::OmpState>() {
        if let Ok(mut sessions) = state.sessions.lock() {
            for (_, session) in sessions.drain() {
                session.stop();
            }
        }
        if let Ok(mut cwds) = state.window_cwds.lock() {
            cwds.clear();
        }
    }
}

pub fn setup(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(ShellState::default());

    let status = MenuItem::with_id(app, "status", "No session", false, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "Show omp", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit omp", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &PredefinedMenuItem::separator(app)?, &show, &quit])?;

    let tray = TrayIconBuilder::with_id("omp-tray")
        .icon(app.default_window_icon().expect("default window icon").clone())
        .tooltip("omp")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                stop_omp_session(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    if let Some(state) = app.try_state::<ShellState>() {
        *state.tray.lock().unwrap() = Some(tray);
        *state.status_item.lock().unwrap() = Some(status);
    }

    // Close-to-tray: closing the window keeps running sessions alive; the
    // tray menu's Quit is the real exit. Toggleable from Settings.
    if let Some(window) = app.get_webview_window("main") {
        let win = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = win
                    .app_handle()
                    .try_state::<ShellState>()
                    .map(|s| s.close_to_tray.load(Ordering::Relaxed))
                    .unwrap_or(true);
                if close_to_tray {
                    api.prevent_close();
                    let _ = win.hide();
                } else {
                    let app = win.app_handle().clone();
                    stop_omp_session(&app);
                    app.exit(0);
                }
            }
        });
    }

    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    app.handle().global_shortcut().on_shortcut(HOTKEY, |app, _shortcut, event| {
        if event.state() == ShortcutState::Pressed {
            toggle_main_window(app);
        }
    })?;

    Ok(())
}
