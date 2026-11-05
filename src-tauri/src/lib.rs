mod commands;
mod cover;
mod library;
mod model;
mod paths;
mod repo;
mod settings;
mod source;
mod state;
mod storage;
mod tags;
mod update;

use std::sync::Arc;

use library::LibraryStore;
use repo::{MusicRepository, RecommendRepository};
use settings::SettingsStore;
use state::AppState;
use tauri::Emitter;
use tauri::Manager;

/// Frontend listens for these and drives the existing audio element.
const PLAYBACK_COMMAND: &str = "playback-command";

fn send_playback_command(app: &tauri::AppHandle, action: &str) {
    let _ = app.emit(PLAYBACK_COMMAND, action);
}

/// Append panics to `<app data>/maoer-radio/panic.log` so a release build,
/// which has no reachable stderr, still leaves a trace behind.
fn install_panic_logger(data_dir: &std::path::Path) {
    use std::io::Write;

    let log_path = data_dir.join("panic.log");
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        default_hook(info);
        let message = match info.payload().downcast_ref::<&str>() {
            Some(text) => (*text).to_string(),
            None => info
                .payload()
                .downcast_ref::<String>()
                .cloned()
                .unwrap_or_else(|| "non-string panic payload".to_string()),
        };
        let location = info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_else(|| "unknown".to_string());
        let thread = std::thread::current().name().unwrap_or("unnamed").to_string();
        let line = format!(
            "[{}] thread '{thread}' panicked at {location}: {message}\n",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
        );
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = file.write_all(line.as_bytes());
        }
        eprintln!("{line}");
    }));
}

#[cfg(desktop)]
fn setup_desktop(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let lyrics = MenuItem::with_id(app, "lyrics", "桌面歌词", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "播放 / 暂停", true, None::<&str>)?;
    let prev = MenuItem::with_id(app, "prev", "上一首", true, None::<&str>)?;
    let next = MenuItem::with_id(app, "next", "下一首", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &show,
            &lyrics,
            &PredefinedMenuItem::separator(app)?,
            &toggle,
            &prev,
            &next,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("猫耳收音机")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal_main_window(app),
            "lyrics" => {
                // Tray is the escape hatch for a click-through window: unlock first,
                // then hide, then show.
                let (visible, locked) = app
                    .get_webview_window("desktop-lyrics")
                    .map(|w| {
                        (
                            w.is_visible().unwrap_or(false),
                            DESKTOP_LYRICS_LOCKED.load(std::sync::atomic::Ordering::Relaxed),
                        )
                    })
                    .unwrap_or((false, false));
                let (next_visible, next_locked) = if !visible {
                    (Some(true), Some(false))
                } else if locked {
                    (None, Some(false))
                } else {
                    (Some(false), None)
                };
                match apply_desktop_lyrics(app, next_visible, next_locked) {
                    Ok(status) => broadcast_desktop_lyrics(app, &status),
                    Err(e) => eprintln!("toggle desktop lyrics failed: {e}"),
                }
            }
            "toggle" => send_playback_command(app, "toggle"),
            "prev" => send_playback_command(app, "prev"),
            "next" => send_playback_command(app, "next"),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;

    // Media keys: best-effort — macOS may refuse without accessibility rights.
    use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut, ShortcutState};
    let shortcuts = [
        (Code::MediaPlayPause, "toggle"),
        (Code::MediaTrackNext, "next"),
        (Code::MediaTrackPrevious, "prev"),
    ];
    for (code, action) in shortcuts {
        let shortcut = Shortcut::new(None, code);
        let result = app.global_shortcut().on_shortcut(shortcut, move |app, _, event| {
            if event.state() == ShortcutState::Pressed {
                send_playback_command(app, action);
            }
        });
        if let Err(e) = result {
            eprintln!("register media key {code:?} failed: {e}");
        }
    }
    Ok(())
}

#[cfg(desktop)]
fn reveal_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg(desktop)]
static DESKTOP_LYRICS_LOCKED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Placed once on first show so the overlay does not cover the middle of the screen.
#[cfg(desktop)]
static DESKTOP_LYRICS_PLACED: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// Park the overlay horizontally centered near the bottom of the current monitor.
#[cfg(desktop)]
fn place_desktop_lyrics(window: &tauri::WebviewWindow) {
    use std::sync::atomic::Ordering;

    if DESKTOP_LYRICS_PLACED.swap(true, Ordering::Relaxed) {
        return;
    }
    let (Ok(Some(monitor)), Ok(size)) = (window.current_monitor(), window.outer_size()) else {
        return;
    };
    let screen = monitor.size();
    let scale = monitor.scale_factor();
    let screen_w = screen.width as f64 / scale;
    let screen_h = screen.height as f64 / scale;
    let win_w = size.width as f64 / scale;
    let win_h = size.height as f64 / scale;
    let x = ((screen_w - win_w) / 2.0).max(0.0);
    // ~12% of the screen height above the bottom edge, clear of most docks.
    let y = (screen_h * 0.88 - win_h / 2.0).max(0.0);
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

#[cfg(desktop)]
#[derive(serde::Serialize)]
struct DesktopLyricsStatus {
    visible: bool,
    locked: bool,
}

/// Show/hide the frameless lyrics overlay and toggle its click-through mode.
/// Both arguments are optional so the tray only flips visibility.
#[cfg(desktop)]
fn apply_desktop_lyrics(
    app: &tauri::AppHandle,
    visible: Option<bool>,
    locked: Option<bool>,
) -> Result<DesktopLyricsStatus, String> {
    use std::sync::atomic::Ordering;

    let window = app
        .get_webview_window("desktop-lyrics")
        .ok_or_else(|| "桌面歌词窗口不可用".to_string())?;
    if let Some(locked) = locked {
        DESKTOP_LYRICS_LOCKED.store(locked, Ordering::Relaxed);
        window
            .set_ignore_cursor_events(locked)
            .map_err(|e| e.to_string())?;
    }
    if let Some(visible) = visible {
        let result = if visible {
            place_desktop_lyrics(&window);
            window.show().and_then(|_| window.set_always_on_top(true))
        } else {
            window.hide()
        };
        result.map_err(|e| e.to_string())?;
    }
    Ok(DesktopLyricsStatus {
        visible: window.is_visible().unwrap_or(false),
        locked: DESKTOP_LYRICS_LOCKED.load(Ordering::Relaxed),
    })
}

/// The tray can flip the overlay without going through the frontend, so the
/// main window gets the result as an event and re-syncs its settings card.
#[cfg(desktop)]
fn broadcast_desktop_lyrics(app: &tauri::AppHandle, status: &DesktopLyricsStatus) {
    let _ = app.emit_to("main", "desktop-lyrics-status", status);
}

#[cfg(desktop)]
#[tauri::command]
fn set_desktop_lyrics(
    app: tauri::AppHandle,
    visible: Option<bool>,
    locked: Option<bool>,
) -> Result<DesktopLyricsStatus, String> {
    let status = apply_desktop_lyrics(&app, visible, locked)?;
    broadcast_desktop_lyrics(&app, &status);
    Ok(status)
}

#[cfg(not(desktop))]
#[tauri::command]
fn set_desktop_lyrics(
    _app: tauri::AppHandle,
    _visible: Option<bool>,
    _locked: Option<bool>,
) -> Result<serde_json::Value, String> {
    Err("桌面歌词仅支持桌面端".to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_media_session::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    }

    builder
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("app data dir")
                .join("maoer-radio");
            std::fs::create_dir_all(&data_dir).ok();
            install_panic_logger(&data_dir);

            let settings = SettingsStore::load(data_dir.join("settings.json"));
            // Seed bundled netease/qq/kuwo; enable them if settings still have none selected.
            let sources_dir = crate::paths::resolve_sources_dir(app.handle(), &settings.get());
            let seeded = crate::source::ensure_builtin_sources(&sources_dir);
            let mut next = settings.get();
            let mut changed = false;
            for id in seeded {
                if !next.enabled_sources.contains(&id) {
                    next.enabled_sources.push(id);
                    changed = true;
                }
            }
            if next.enabled_sources.is_empty() {
                let registry = crate::source::SourceRegistry::load(&sources_dir);
                next.enabled_sources = registry.list_info().into_iter().map(|i| i.id).collect();
                changed = !next.enabled_sources.is_empty();
            }
            if changed {
                settings.save(next);
            }

            let recommend = RecommendRepository::load(data_dir.join("recommend.json"));
            recommend.start_background_sync(app.handle().clone());

            let cover_dir = data_dir.join("covers");
            std::fs::create_dir_all(&cover_dir).ok();

            let state = AppState {
                music: Arc::new(MusicRepository::new()),
                recommend,
                library: LibraryStore::load(data_dir.join("library.json")),
                settings,
                cover_dir,
            };
            app.manage(state);

            #[cfg(desktop)]
            {
                setup_desktop(app.handle())?;
                // Closing the window keeps playback alive in the tray; quit from
                // the tray menu instead.
                if let Some(window) = app.get_webview_window("main") {
                    let win = window.clone();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                            api.prevent_close();
                            let _ = win.hide();
                        }
                    });
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_sources,
            commands::get_default_sources_dir,
            commands::import_source_from_url,
            commands::import_source_from_file,
            commands::get_settings,
            commands::save_settings,
            commands::search_tracks,
            commands::ensure_playable,
            commands::load_recommend,
            commands::refresh_recommend,
            commands::get_library,
            commands::get_favorites,
            commands::is_favorite,
            commands::toggle_favorite,
            commands::create_playlist,
            commands::delete_playlist,
            commands::import_playlist_from_url,
            commands::add_to_playlist,
            commands::rename_playlist,
            commands::remove_from_playlist,
            commands::move_playlist_track,
            commands::export_library,
            commands::import_library,
            commands::export_library_to_path,
            commands::import_library_from_path,
            commands::export_library_to_download_dir,
            commands::get_default_download_dir,
            commands::list_download_dir_presets,
            commands::download_track,
            commands::scan_local_tracks,
            commands::fetch_cover,
            commands::get_cache_stats,
            commands::clear_cache,
            update::check_update,
            set_desktop_lyrics,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
