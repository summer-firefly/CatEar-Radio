use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::model::{
    AppSettings, LibrarySnapshot, RecommendCatalog, SearchPageResult, SourceInfo, StoredPlaylist,
    Track,
};
use crate::paths::{
    default_download_dir, download_dir_presets, resolve_download_dir, resolve_sources_dir,
    DownloadDirPreset,
};
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
    limit_per_source: Option<u32>,
) -> Result<SearchPageResult, String> {
    let settings = state.settings.get();
    let (_, sources) = load_sources(&app, &settings);
    let limit = limit_per_source
        .unwrap_or(settings.limit_per_source)
        .clamp(1, 30);
    state
        .music
        .search(
            &sources,
            &keyword,
            &settings.enabled_sources,
            limit,
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
    // Scanning puts the absolute path in the uid, so local playback still works
    // after favourites / recent / session restores dropped the audio URL.
    if track.source == crate::model::MusicSourceId::Local {
        let mut local = track;
        local.audio_url = local
            .uid
            .strip_prefix("local:")
            .map(Path::new)
            .filter(|p| p.is_file())
            .map(|p| p.to_string_lossy().into_owned());
        local.details_loaded = true;
        local.quality = Some("local".into());
        local.quality_label = Some("本地".into());
        return Ok(local);
    }

    let settings = state.settings.get();
    let dir = resolve_download_dir(&app, &settings);
    let quality = crate::model::AudioQuality::from_id(&settings.quality);

    let (_, sources) = load_sources(&app, &settings);
    // Always resolve details (lyrics etc.); local file only overrides the audio URL.
    let mut out = state
        .music
        .ensure_playable(&sources, track.clone(), quality)
        .await;
    if let Some(local) = find_local_audio(&dir, &track) {
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
    }
    Ok(out)
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
pub fn rename_playlist(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<(), String> {
    state.library.rename_playlist(&id, &name)
}

#[tauri::command]
pub fn remove_from_playlist(
    state: State<'_, AppState>,
    playlist_id: String,
    track_uid: String,
) -> Result<(), String> {
    state.library.remove_from_playlist(&playlist_id, &track_uid)
}

#[tauri::command]
pub fn move_playlist_track(
    state: State<'_, AppState>,
    playlist_id: String,
    from_index: usize,
    to_index: usize,
) -> Result<(), String> {
    state
        .library
        .move_playlist_track(&playlist_id, from_index, to_index)
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
pub fn export_library_to_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    state.library.export_to_path(std::path::Path::new(&path))
}

#[tauri::command]
pub fn import_library_from_path(state: State<'_, AppState>, path: String) -> Result<(), String> {
    state.library.import_from_path(std::path::Path::new(&path))
}

/// Android-friendly export into the resolved download directory.
#[tauri::command]
pub fn export_library_to_download_dir(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let settings = state.settings.get();
    let dir = resolve_download_dir(&app, &settings);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建下载目录：{e}"))?;
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("maoer-library-{stamp}.json"));
    state.library.export_to_path(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_default_download_dir(app: AppHandle) -> String {
    default_download_dir(&app).to_string_lossy().into_owned()
}

#[tauri::command]
pub fn list_download_dir_presets(app: AppHandle) -> Vec<DownloadDirPreset> {
    download_dir_presets(&app)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub path: String,
    pub already_exists: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress {
    uid: String,
    downloaded: u64,
    total: u64,
}

/// Stream the response body straight to disk so large FLAC files never sit in RAM.
async fn stream_to_file(
    app: &AppHandle,
    uid: &str,
    url: &str,
    path: &Path,
) -> Result<(), String> {
    use futures_util::StreamExt;
    use std::io::Write;

    let client = reqwest::Client::builder()
        .user_agent("MaoerRadio/0.1")
        .timeout(std::time::Duration::from_secs(300))
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
    let total = resp.content_length().unwrap_or(0);

    let mut file = std::fs::File::create(path).map_err(|e| format!("写入文件失败：{e}"))?;
    let mut downloaded: u64 = 0;
    let mut last_emit: u64 = 0;
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("读取音频失败：{e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("写入文件失败：{e}"))?;
        downloaded += chunk.len() as u64;
        // Emit at most every 256 KB to keep the event bridge quiet.
        if downloaded - last_emit >= 256 * 1024 || downloaded == total {
            last_emit = downloaded;
            let _ = app.emit(
                "download-progress",
                DownloadProgress {
                    uid: uid.to_string(),
                    downloaded,
                    total,
                },
            );
        }
    }
    file.sync_all().map_err(|e| format!("写入文件失败：{e}"))?;
    drop(file);

    if downloaded == 0 {
        let _ = std::fs::remove_file(path);
        return Err("下载内容为空".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn download_track(
    app: AppHandle,
    state: State<'_, AppState>,
    track: Track,
) -> Result<DownloadResult, String> {
    let settings = state.settings.get();
    let dir = resolve_download_dir(&app, &settings);
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建下载目录：{e}"))?;

    if let Some(existing) = find_local_audio(&dir, &track) {
        return Ok(DownloadResult {
            path: existing.to_string_lossy().into_owned(),
            already_exists: true,
        });
    }

    let (_, sources) = load_sources(&app, &settings);
    let quality = crate::model::AudioQuality::from_id(&settings.quality);
    let detailed = state
        .music
        .ensure_playable(&sources, track, quality)
        .await;

    if let Some(existing) = find_local_audio(&dir, &detailed) {
        return Ok(DownloadResult {
            path: existing.to_string_lossy().into_owned(),
            already_exists: true,
        });
    }

    let url = detailed
        .audio_url
        .as_deref()
        .filter(|u| !u.is_empty())
        .ok_or_else(|| "暂无可用下载地址".to_string())?
        .to_string();

    let stem = track_filename_stem(&detailed);
    let ext = guess_ext(&url);
    let path = unique_path(&dir, &stem, ext);
    stream_to_file(&app, &detailed.uid, &url, &path).await?;

    Ok(DownloadResult {
        path: path.to_string_lossy().into_owned(),
        already_exists: false,
    })
}

/// Walk `dir` (bounded depth) collecting playable audio files.
fn collect_audio_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth == 0 || out.len() >= 5000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_audio_files(&path, depth - 1, out);
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if AUDIO_EXTS.contains(&ext.as_str()) {
            out.push(path);
        }
    }
}

/// `歌手 - 歌名.mp3` → (artist, title); plain filenames become the title.
fn parse_file_stem(stem: &str) -> (String, String) {
    if let Some((artist, title)) = stem.split_once(" - ") {
        let artist = artist.trim();
        let title = title.trim();
        if !artist.is_empty() && !title.is_empty() {
            return (artist.to_string(), title.to_string());
        }
    }
    (String::new(), stem.trim().to_string())
}

/// Scan a folder (defaults to the download dir) for local audio files.
#[tauri::command]
pub fn scan_local_tracks(
    app: AppHandle,
    state: State<'_, AppState>,
    dir: Option<String>,
) -> Result<Vec<Track>, String> {
    let settings = state.settings.get();
    let root = match dir.map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => resolve_download_dir(&app, &settings),
    };
    if !root.is_dir() {
        return Err(format!("目录不存在：{}", root.to_string_lossy()));
    }

    let mut files = Vec::new();
    collect_audio_files(&root, 4, &mut files);
    files.sort();

    let tracks = files
        .into_iter()
        .map(|path| {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("未命名")
                .to_string();
            let (artist, title) = parse_file_stem(&stem);
            // Sub-folder name doubles as the album; files at the root show "本地文件".
            let album = path
                .parent()
                .filter(|p| *p != root.as_path())
                .and_then(|p| p.file_name())
                .and_then(|n| n.to_str())
                .map(str::to_string)
                .unwrap_or_else(|| "本地文件".into());
            Track {
                // Path-derived uid keeps local tracks stable across scans.
                uid: format!("local:{}", path.to_string_lossy()),
                source: crate::model::MusicSourceId::Local,
                display_index: 1,
                keyword: stem.clone(),
                song_id: String::new(),
                song_mid: String::new(),
                qq_id: String::new(),
                qq_search_key: String::new(),
                qq_index: 0,
                title,
                artist,
                album,
                cover: None,
                audio_url: Some(path.to_string_lossy().into_owned()),
                lrc: None,
                lrc_url: None,
                details_loaded: true,
                quality: Some("local".into()),
                quality_label: Some("本地".into()),
                pay: None,
            }
        })
        .collect();

    Ok(tracks)
}

/// Fetch a cover through the on-disk cache and return it as a data URL.
///
/// Going through Rust means the WKWebView never sees the slow CDN directly:
/// the second view of a list is served from the local file in a few ms.
#[tauri::command]
pub async fn fetch_cover(
    state: State<'_, AppState>,
    url: String,
    variant: String,
) -> Result<String, String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err("缺少封面地址".into());
    }
    let variant = crate::cover::CoverVariant::parse(&variant);
    // Ask the CDN for a right-sized render before caching, so a 40px row does
    // not download an 800px JPEG.
    let target = crate::cover::sized_cover_url(trimmed, variant);
    let cached = crate::cover::read_cached(&state.cover_dir, &target, variant);
    let (bytes, ext) = match cached {
        Some(hit) => hit,
        None => crate::cover::fetch_and_cache(&state.cover_dir, &target, variant).await?,
    };
    Ok(format!(
        "data:image/{ext};base64,{}",
        base64_encode(&bytes)
    ))
}

const B64_TABLE: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = ((b[0] as u32) << 16) | ((b[1] as u32) << 8) | b[2] as u32;
        out.push(B64_TABLE[(n >> 18) as usize & 63] as char);
        out.push(B64_TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64_TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64_encode;

    #[test]
    fn base64_matches_known_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
