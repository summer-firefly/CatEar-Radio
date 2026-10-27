use serde_json::{Map, Value};

use crate::model::{infer_quality_from_url, MusicSourceId, Track};

use super::get_text;

pub struct KuwoMusicSource {
    base_url: String,
}

impl KuwoMusicSource {
    pub fn new(base_url: impl Into<String>) -> Self {
        let base = base_url.into();
        let base_url = base.trim().trim_end_matches('/').to_string();
        Self { base_url }
    }

    pub async fn search(&self, keyword: &str, limit: u32, _page: u32) -> Result<Vec<Track>, String> {
        let url = format!(
            "{}?msg={}&page=1&limit={limit}",
            self.base_url,
            urlencoding::encode(keyword)
        );
        let body = get_text(&url).await?;
        let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&body) else {
            return Ok(Vec::new());
        };
        let Some(Value::Array(data)) = root.get("data") else {
            return Ok(Vec::new());
        };

        Ok(data
            .iter()
            .enumerate()
            .filter_map(|(idx, el)| {
                let obj = el.as_object()?;
                let rid = obj.get("rid")?.as_str()?.to_string();
                Some(Track {
                    uid: format!("kuwo-{rid}"),
                    source: MusicSourceId::Kuwo,
                    display_index: (idx + 1) as i32,
                    keyword: keyword.to_string(),
                    song_id: rid,
                    song_mid: String::new(),
                    qq_id: String::new(),
                    qq_search_key: String::new(),
                    qq_index: 0,
                    title: str_field(obj, "song"),
                    artist: str_field(obj, "singer"),
                    album: str_field(obj, "album"),
                    cover: obj
                        .get("picture")
                        .and_then(|v| v.as_str())
                        .map(str::to_string),
                    audio_url: None,
                    lrc: None,
                    lrc_url: None,
                    details_loaded: false,
                    quality: None,
                    quality_label: None,
                    pay: None,
                })
            })
            .collect())
    }

    pub async fn fetch_details(&self, track: Track) -> Result<Track, String> {
        let n = track.display_index.max(1);
        // br=1 returns flac (often fails in WKWebView); br=320 returns mp3.
        let url = format!(
            "{}?msg={}&n={n}&br=320",
            self.base_url,
            urlencoding::encode(&track.keyword)
        );
        let body = get_text(&url).await?;
        let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&body) else {
            return Ok(track);
        };
        let Some(Value::Object(d)) = root.get("data") else {
            return Ok(track);
        };

        let audio_url = d
            .get("url")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or(track.audio_url.clone());
        let quality_text = format!("{} {}", str_field(d, "level"), str_field(d, "format")).to_lowercase();
        let (quality, quality_label) =
            if RegexLike::lossless(&quality_text) {
                (Some("lossless".into()), Some("LOSSLESS".into()))
            } else {
                infer_quality_from_url(audio_url.as_deref())
            };

        let song_id = opt_str(d, "rid").unwrap_or(track.song_id.clone());
        // oiapi detail JSON has no lyric fields; pull from Kuwo open API by musicId.
        let mut lrc = first_str(d, &["lyric", "lrc", "lyrics"]).or(track.lrc.clone());
        if lrc.as_deref().unwrap_or("").is_empty() {
            if let Some(music_id) = kuwo_music_id(d, &song_id) {
                lrc = fetch_kuwo_lrc(&music_id).await;
            }
        }

        Ok(Track {
            title: opt_str(d, "song").unwrap_or(track.title),
            artist: opt_str(d, "singer").unwrap_or(track.artist),
            album: opt_str(d, "album").unwrap_or(track.album),
            cover: opt_str(d, "picture").or(track.cover),
            song_id,
            audio_url,
            lrc,
            lrc_url: None,
            details_loaded: true,
            quality,
            quality_label,
            ..track
        })
    }
}

fn kuwo_music_id(d: &Map<String, Value>, song_id: &str) -> Option<String> {
    if let Some(id) = d.get("id") {
        if let Some(n) = id.as_u64() {
            return Some(n.to_string());
        }
        if let Some(s) = id.as_str().filter(|s| !s.is_empty()) {
            return Some(s.trim_start_matches("MUSIC_").to_string());
        }
    }
    let rid = song_id.trim();
    if rid.is_empty() {
        return None;
    }
    Some(rid.trim_start_matches("MUSIC_").to_string())
}

async fn fetch_kuwo_lrc(music_id: &str) -> Option<String> {
    let url = format!(
        "https://www.kuwo.cn/openapi/v1/www/lyric/getlyric?musicId={}",
        urlencoding::encode(music_id)
    );
    let body = get_text(&url).await.ok()?;
    let Value::Object(root) = serde_json::from_str(&body).ok()? else {
        return None;
    };
    let list = root
        .get("data")
        .and_then(|v| v.get("lrclist"))
        .and_then(|v| v.as_array())?;
    if list.is_empty() {
        return None;
    }

    let mut lines = Vec::new();
    for item in list {
        let obj = item.as_object()?;
        let text = obj
            .get("lineLyric")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if text.is_empty() {
            continue;
        }
        let secs = obj
            .get("time")
            .and_then(|v| {
                v.as_str()
                    .and_then(|s| s.parse::<f64>().ok())
                    .or_else(|| v.as_f64())
            })
            .unwrap_or(0.0)
            .max(0.0);
        let total_cs = (secs * 100.0).round() as u64;
        let mm = total_cs / 6000;
        let ss = (total_cs % 6000) / 100;
        let cs = total_cs % 100;
        lines.push(format!("[{mm:02}:{ss:02}.{cs:02}]{text}"));
    }
    if lines.is_empty() {
        None
    } else {
        Some(lines.join("\n"))
    }
}

struct RegexLike;
impl RegexLike {
    fn lossless(text: &str) -> bool {
        ["lossless", "无损", "flac", "wav", "ape", "alac", "aiff", "zp", "sq"]
            .iter()
            .any(|k| text.contains(k))
    }
}

fn str_field(obj: &Map<String, Value>, key: &str) -> String {
    obj.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn opt_str(obj: &Map<String, Value>, key: &str) -> Option<String> {
    obj.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

fn first_str(obj: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| obj.get(*k).and_then(|v| v.as_str()).map(str::to_string))
}
