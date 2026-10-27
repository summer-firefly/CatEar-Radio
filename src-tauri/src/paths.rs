use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::model::AppSettings;

pub fn resolve_sources_dir(app: &AppHandle, settings: &AppSettings) -> PathBuf {
    let trimmed = settings.sources_dir.trim();
    if !trimmed.is_empty() {
        return PathBuf::from(trimmed);
    }
    app.path()
        .app_data_dir()
        .map(|p| p.join("maoer-radio").join("sources"))
        .unwrap_or_else(|_| PathBuf::from("sources"))
}

pub fn resolve_download_dir(settings: &AppSettings) -> PathBuf {
    let trimmed = settings.download_dir.trim();
    if trimmed.is_empty() {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(|h| PathBuf::from(h).join("Music").join("猫耳收音机"))
            .unwrap_or_else(|| PathBuf::from("猫耳收音机"))
    } else {
        PathBuf::from(trimmed)
    }
}

pub fn default_download_dir() -> PathBuf {
    resolve_download_dir(&AppSettings::default())
}
