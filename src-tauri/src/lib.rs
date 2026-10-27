mod commands;
mod library;
mod model;
mod paths;
mod repo;
mod settings;
mod source;
mod state;

use std::sync::Arc;

use library::LibraryStore;
use repo::{MusicRepository, RecommendRepository};
use settings::SettingsStore;
use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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

            let state = AppState {
                music: Arc::new(MusicRepository::new()),
                recommend,
                library: LibraryStore::load(data_dir.join("library.json")),
                settings,
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
            commands::export_library,
            commands::import_library,
            commands::get_default_download_dir,
            commands::list_download_dir_presets,
            commands::download_track,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
