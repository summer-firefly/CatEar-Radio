use std::path::{Path, PathBuf};

use tauri::{AppHandle, State};

use crate::model::{
    AppSettings, LibrarySnapshot, RecommendCatalog, SourceInfo, StoredPlaylist, Track,
};
use crate::paths::{default_download_dir, resolve_download_dir, resolve_sources_dir};
use crate::source::{
    ensure_builtin_sources, MusicSources, SourceManifest, SourceRegistry,
};
use crate::state::AppState;

fn load_sources(app: &AppHandle, settings: &AppSettings) -> (SourceRegistry, MusicSources) {
    let dir = resolve_sources_dir(app, settings);
    ensure_builtin_sources(&dir);
    let registry = SourceRegistry::load(dir);
    let music_sources = MusicSources::from_registry(&registry);
    (registry, music_sources)
}

fn install_source_manifest(
    app: &AppHandle,
    state: &State<'_, AppState>,
    text: &str,
) -> Result<SourceInfo, String> {
    let manifest = SourceManifest::parse_json(text)?;
    let id = manifest
        .source_id()
        .ok_or_else(|| "不支持的音源".to_string())?;
    let settings = state.settings.get();
    let dir = resolve_sources_dir(app, &settings);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建音源目录：{e}"))?;
    let path = dir.join(format!("{}.json", id.id()));
    let json = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| format!("写入音源失败：{e}"))?;

    let mut next = state.settings.get();
    if !next.enabled_sources.contains(&id) {
        next.enabled_sources.push(id);
        state.settings.save(next);
    }

    manifest
        .to_info()
        .ok_or_else(|| "音源信息无效".to_string())
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        "未命名".into()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn guess_ext(url: &str) -> &'static str {
    let lower = url.to_lowercase();
    if lower.contains(".flac") {
        "flac"
    } else if lower.contains(".m4a") || lower.contains("mp4a") {
        "m4a"
    } else if lower.contains(".aac") {
        "aac"
    } else if lower.contains(".wav") {
        "wav"
    } else if lower.contains(".ogg") {
        "ogg"
    } else {
        "mp3"
    }
}

fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut path = dir.join(format!("{stem}.{ext}"));
    if !path.exists() {
        return path;
    }
    for i in 2..1000 {
        path = dir.join(format!("{stem} ({i}).{ext}"));
        if !path.exists() {
            return path;
        }
    }
    dir.join(format!("{stem}-{}.{}", uuid::Uuid::new_v4(), ext))
}

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "m4a", "aac", "wav", "ogg"];

fn track_filename_stem(track: &Track) -> String {
    let title_raw = track.title.trim();
    let title = sanitize_filename(if title_raw.is_empty() {
        "未命名"
    } else {
        title_raw
    });
    let artist_raw = track.artist.trim();
    if artist_raw.is_empty() {
        title
    } else {
        format!("{} - {}", sanitize_filename(artist_raw), title)
    }
}

/// Prefer exact download naming, then `(n)` duplicates, then title-only fuzzy match.
fn find_local_audio(dir: &Path, track: &Track) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }

    let stem = track_filename_stem(track);
    for ext in AUDIO_EXTS {
        let path = dir.join(format!("{stem}.{ext}"));
        if path.is_file() {
            return Some(path);
        }
    }
    for ext in AUDIO_EXTS {
        for i in 2..50 {
            let path = dir.join(format!("{stem} ({i}).{ext}"));
            if path.is_file() {
                return Some(path);
            }
        }
    }

    let stem_lower = stem.to_lowercase();
    let title_lower = sanitize_filename(track.title.trim()).to_lowercase();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !AUDIO_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        if name == stem_lower || name.starts_with(&format!("{stem_lower} (")) {
            return Some(path);
        }
        if !title_lower.is_empty()
            && (name == title_lower
                || name.ends_with(&format!(" - {title_lower}"))
                || name.ends_with(&format!(" - {title_lower} (")))
        {
            return Some(path);
        }
    }
    None
}

#[tauri::command]
pub fn list_sources(app: AppHandle, state: State<'_, AppState>) -> Vec<SourceInfo> {
    let settings = state.settings.get();
    let (registry, _) = load_sources(&app, &settings);
    registry.list_info()
}

#[tauri::command]
pub fn get_default_sources_dir(app: AppHandle) -> String {
    resolve_sources_dir(&app, &AppSettings::default())
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
pub async fn import_source_from_url(
    app: AppHandle,
    state: State<'_, AppState>,
    url: String,
) -> Result<SourceInfo, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("请输入音源 URL".into());
    }
    if !(trimmed.starts_with("http://") || trimmed.starts_with("https://")) {
        return Err("URL 需以 http:// 或 https:// 开头".into());
    }
    let text = crate::source::get_text(trimmed).await?;
    install_source_manifest(&app, &state, &text)
}

#[tauri::command]
pub fn import_source_from_file(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<SourceInfo, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("请选择音源文件".into());
    }
    let text =
        std::fs::read_to_string(trimmed).map_err(|e| format!("读取音源文件失败：{e}"))?;
    install_source_manifest(&app, &state, &text)
}

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppSettings {
    state.settings.get()
}

#[tauri::command]
pub fn save_settings(state: State<'_, AppState>, settings: AppSettings) -> AppSettings {
    state.settings.save(settings)
}

#[tauri::command]
pub async fn search_tracks(
    app: AppHandle,
    state: State<'_, AppState>,
    keyword: String,
    page: Option<u32>,
    reset: Option<bool>,
) -> Result<Vec<Track>, String> {
    let settings = state.settings.get();
    let (_, sources) = load_sources(&app, &settings);
    state
        .music
        .search(
            &sources,
            &keyword,
            &settings.enabled_sources,
            settings.limit_per_source,
            page.unwrap_or(1),
            reset.unwrap_or(true),
        )
        .await
}

#[tauri::command]
pub async fn ensure_playable(
    app: AppHandle,
    state: State<'_, AppState>,
    track: Track,
) -> Result<Track, String> {
    let settings = state.settings.get();
    let dir = resolve_download_dir(&settings);

    // Local download wins over network / cache audio URL.
    if let Some(local) = find_local_audio(&dir, &track) {
        let mut out = state
            .music
            .cached(&track.uid)
            .unwrap_or_else(|| track.clone());
        out.title = if out.title.trim().is_empty() {
            track.title.clone()
        } else {
            out.title
        };
        out.artist = if out.artist.trim().is_empty() {
            track.artist.clone()
        } else {
            out.artist
        };
        out.cover = out.cover.or(track.cover.clone());
        out.audio_url = Some(local.to_string_lossy().into_owned());
        out.details_loaded = true;
        out.quality = Some("local".into());
        out.quality_label = Some("本地".into());
        return Ok(out);
    }

    let (_, sources) = load_sources(&app, &settings);
    Ok(state.music.ensure_playable(&sources, track).await)
}

/// Returns locally cached recommendations only (filled by background sync).
#[tauri::command]
pub fn load_recommend(state: State<'_, AppState>) -> RecommendCatalog {
    state.recommend.get()
}

/// Force a network refresh of charts / hot tracks.
#[tauri::command]
pub async fn refresh_recommend(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RecommendCatalog, String> {
    state.recommend.refresh(&app).await
}

#[tauri::command]
pub fn get_library(state: State<'_, AppState>) -> LibrarySnapshot {
    state.library.snapshot()
}

#[tauri::command]
pub fn get_favorites(state: State<'_, AppState>) -> Vec<Track> {
    state.library.favorites()
}

#[tauri::command]
pub fn is_favorite(state: State<'_, AppState>, uid: String) -> bool {
    state.library.is_favorite(&uid)
}

#[tauri::command]
pub fn toggle_favorite(state: State<'_, AppState>, track: Track) -> bool {
    state.library.toggle_favorite(&track)
}

#[tauri::command]
pub fn create_playlist(state: State<'_, AppState>, name: String) -> StoredPlaylist {
    state.library.create_playlist(&name)
}

#[tauri::command]
pub fn delete_playlist(state: State<'_, AppState>, id: String) {
    state.library.delete_playlist(&id);
}

#[tauri::command]
pub fn add_to_playlist(
    state: State<'_, AppState>,
    playlist_id: String,
    track: Track,
) -> Result<(), String> {
    state.library.add_to_playlist(&playlist_id, &track)
}

#[tauri::command]
pub fn export_library(state: State<'_, AppState>) -> Result<String, String> {
    state.library.export_json()
}

#[tauri::command]
pub fn import_library(state: State<'_, AppState>, json: String) -> Result<(), String> {
    state.library.import_json(&json)
}

#[tauri::command]
pub fn get_default_download_dir() -> String {
    default_download_dir().to_string_lossy().into_owned()
}

#[tauri::command]
pub async fn download_track(
    app: AppHandle,
    state: State<'_, AppState>,
    track: Track,
) -> Result<String, String> {
    let settings = state.settings.get();
    let dir = resolve_download_dir(&settings);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建下载目录：{e}"))?;

    let (_, sources) = load_sources(&app, &settings);
    let detailed = state.music.ensure_playable(&sources, track).await;
    let url = detailed
        .audio_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .ok_or_else(|| "暂无可用下载地址".to_string())?;

    let client = reqwest::Client::builder()
        .user_agent("MaoerRadio/0.1")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载失败：{e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载失败：HTTP {}", resp.status()));
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取音频失败：{e}"))?;
    if bytes.is_empty() {
        return Err("下载内容为空".into());
    }

    let stem = track_filename_stem(&detailed);
    let ext = guess_ext(url);
    let path = unique_path(&dir, &stem, ext);
    std::fs::write(&path, &bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}
