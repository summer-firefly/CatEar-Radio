use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MusicSourceId {
    Netease,
    Qq,
    Kuwo,
}

impl MusicSourceId {
    pub fn id(self) -> &'static str {
        match self {
            Self::Netease => "netease",
            Self::Qq => "qq",
            Self::Kuwo => "kuwo",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Netease => "网易云",
            Self::Qq => "QQ",
            Self::Kuwo => "酷我",
        }
    }

    pub fn from_id(id: &str) -> Self {
        Self::try_from_id(id).unwrap_or(Self::Netease)
    }

    pub fn try_from_id(id: &str) -> Option<Self> {
        match id.trim().to_ascii_lowercase().as_str() {
            "netease" | "网易云" => Some(Self::Netease),
            "qq" => Some(Self::Qq),
            "kuwo" | "酷我" => Some(Self::Kuwo),
            _ => None,
        }
    }

    pub fn all() -> &'static [Self] {
        &[Self::Netease, Self::Qq, Self::Kuwo]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub uid: String,
    pub source: MusicSourceId,
    #[serde(default = "default_display_index")]
    pub display_index: i32,
    #[serde(default)]
    pub keyword: String,
    #[serde(default)]
    pub song_id: String,
    #[serde(default)]
    pub song_mid: String,
    #[serde(default)]
    pub qq_id: String,
    #[serde(default)]
    pub qq_search_key: String,
    #[serde(default)]
    pub qq_index: i32,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub audio_url: Option<String>,
    #[serde(default)]
    pub lrc: Option<String>,
    #[serde(default)]
    pub lrc_url: Option<String>,
    #[serde(default)]
    pub details_loaded: bool,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub quality_label: Option<String>,
    #[serde(default)]
    pub pay: Option<String>,
}

fn default_display_index() -> i32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendPlaylist {
    pub id: String,
    pub name: String,
    pub subtitle: String,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub track_count: usize,
    #[serde(default)]
    pub tracks: Vec<Track>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecommendCatalog {
    #[serde(default)]
    pub hot_tracks: Vec<Track>,
    #[serde(default)]
    pub hot_playlists: Vec<RecommendPlaylist>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredTrack {
    pub uid: String,
    pub source: String,
    #[serde(default = "default_display_index")]
    pub display_index: i32,
    #[serde(default)]
    pub keyword: String,
    #[serde(default, alias = "songid")]
    pub song_id: String,
    #[serde(default)]
    pub song_mid: String,
    #[serde(default)]
    pub qq_id: String,
    #[serde(default)]
    pub qq_search_key: String,
    #[serde(default)]
    pub qq_index: i32,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub cover: Option<String>,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub quality_label: Option<String>,
    #[serde(default)]
    pub pay: Option<String>,
}

impl From<&Track> for StoredTrack {
    fn from(t: &Track) -> Self {
        Self {
            uid: t.uid.clone(),
            source: t.source.id().to_string(),
            display_index: t.display_index,
            keyword: t.keyword.clone(),
            song_id: t.song_id.clone(),
            song_mid: t.song_mid.clone(),
            qq_id: t.qq_id.clone(),
            qq_search_key: t.qq_search_key.clone(),
            qq_index: t.qq_index,
            title: t.title.clone(),
            artist: t.artist.clone(),
            album: t.album.clone(),
            cover: t.cover.clone(),
            quality: t.quality.clone(),
            quality_label: t.quality_label.clone(),
            pay: t.pay.clone(),
        }
    }
}

impl From<&StoredTrack> for Track {
    fn from(t: &StoredTrack) -> Self {
        Self {
            uid: t.uid.clone(),
            source: MusicSourceId::from_id(&t.source),
            display_index: t.display_index,
            keyword: t.keyword.clone(),
            song_id: t.song_id.clone(),
            song_mid: t.song_mid.clone(),
            qq_id: t.qq_id.clone(),
            qq_search_key: t.qq_search_key.clone(),
            qq_index: t.qq_index,
            title: t.title.clone(),
            artist: t.artist.clone(),
            album: t.album.clone(),
            cover: t.cover.clone(),
            audio_url: None,
            lrc: None,
            lrc_url: None,
            details_loaded: false,
            quality: t.quality.clone(),
            quality_label: t.quality_label.clone(),
            pay: t.pay.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPlaylist {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub tracks: Vec<StoredTrack>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibrarySnapshot {
    #[serde(default = "default_version")]
    pub version: i32,
    #[serde(default)]
    pub saved_at: String,
    #[serde(default)]
    pub favorites: Vec<StoredTrack>,
    #[serde(default)]
    pub playlists: Vec<StoredPlaylist>,
}

fn default_version() -> i32 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// Enabled source ids. Defaults to the three builtins (netease / qq / kuwo).
    #[serde(default = "default_enabled_sources")]
    pub enabled_sources: Vec<MusicSourceId>,
    #[serde(default = "default_limit")]
    pub limit_per_source: u32,
    /// Absolute directory for song downloads. Empty → ~/Music/猫耳收音机
    #[serde(default)]
    pub download_dir: String,
    /// Directory containing `*.json` source manifests. Empty → `{app_data}/sources`
    #[serde(default)]
    pub sources_dir: String,
}

fn default_limit() -> u32 {
    10
}

fn default_enabled_sources() -> Vec<MusicSourceId> {
    MusicSourceId::all().to_vec()
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            enabled_sources: default_enabled_sources(),
            limit_per_source: default_limit(),
            download_dir: String::new(),
            sources_dir: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceInfo {
    pub id: MusicSourceId,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSearchError {
    pub source: MusicSourceId,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchPageResult {
    pub tracks: Vec<Track>,
    #[serde(default)]
    pub errors: Vec<SourceSearchError>,
}

pub fn infer_quality_from_url(url: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(url) = url else {
        return (None, None);
    };
    let lower = url.to_lowercase();
    if lower.contains("flac") || lower.contains("lossless") || lower.contains("ape") {
        (Some("lossless".into()), Some("LOSSLESS".into()))
    } else if lower.contains("320") || lower.contains("hq") {
        (Some("hq".into()), Some("HQ".into()))
    } else if lower.contains("128") {
        (Some("standard".into()), Some("STD".into()))
    } else {
        (Some("standard".into()), Some("STD".into()))
    }
}
