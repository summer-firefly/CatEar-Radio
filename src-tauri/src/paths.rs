use std::path::PathBuf;

use serde::Serialize;
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

pub fn resolve_download_dir(app: &AppHandle, settings: &AppSettings) -> PathBuf {
    let trimmed = settings.download_dir.trim();
    if !trimmed.is_empty() {
        return PathBuf::from(trimmed);
    }
    default_download_dir(app)
}

/// Prefer platform music/audio dir; on Android these are app-scoped external dirs
/// (`getExternalFilesDir`) and do not need storage permission.
pub fn default_download_dir(app: &AppHandle) -> PathBuf {
    if let Ok(audio) = app.path().audio_dir() {
        return audio.join("猫耳收音机");
    }
    if let Ok(dl) = app.path().download_dir() {
        return dl.join("猫耳收音机");
    }
    if let Ok(data) = app.path().app_data_dir() {
        return data.join("maoer-radio").join("downloads");
    }
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(|h| PathBuf::from(h).join("Music").join("猫耳收音机"))
        .unwrap_or_else(|| PathBuf::from("猫耳收音机"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadDirPreset {
    pub id: String,
    pub label: String,
    pub path: String,
}

pub fn download_dir_presets(app: &AppHandle) -> Vec<DownloadDirPreset> {
    let mut out = Vec::new();
    if let Ok(audio) = app.path().audio_dir() {
        let path = audio.join("猫耳收音机");
        out.push(DownloadDirPreset {
            id: "audio".into(),
            label: "音乐目录".into(),
            path: path.to_string_lossy().into_owned(),
        });
    }
    if let Ok(dl) = app.path().download_dir() {
        let path = dl.join("猫耳收音机");
        out.push(DownloadDirPreset {
            id: "download".into(),
            label: "下载目录".into(),
            path: path.to_string_lossy().into_owned(),
        });
    }
    if let Ok(data) = app.path().app_data_dir() {
        let path = data.join("maoer-radio").join("downloads");
        out.push(DownloadDirPreset {
            id: "app".into(),
            label: "应用数据目录".into(),
            path: path.to_string_lossy().into_owned(),
        });
    }
    out
}
