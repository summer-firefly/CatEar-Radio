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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_media_session::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("app data dir")
                .join("maoer-radio");
            std::fs::create_dir_all(&data_dir).ok();

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
