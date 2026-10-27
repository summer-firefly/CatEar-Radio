use serde_json::{Map, Value};
use tokio::task::JoinSet;

use crate::model::{infer_quality_from_url, MusicSourceId, Track};

use super::get_text;

pub struct QqMusicSource {
    base_url: String,
}

impl QqMusicSource {
    pub fn new(base_url: impl Into<String>) -> Self {
        let base = base_url.into();
        let base_url = base.trim().trim_end_matches('/').to_string();
        Self { base_url }
    }

    pub async fn search(&self, keyword: &str, limit: u32, _page: u32) -> Result<Vec<Track>, String> {
        let url = format!(
            "{}?msg={}&type=json",
            self.base_url,
            urlencoding::encode(keyword)
        );
        let body = get_text(&url).await?;
        let Ok(Value::Array(data)) = serde_json::from_str::<Value>(&body) else {
            return Ok(Vec::new());
        };

        // Drop paid tracks — the open API returns no playable URL for them.
        let mut tracks: Vec<Track> = data
            .iter()
            .filter_map(|el| {
                let obj = el.as_object()?;
                let pay = obj.get("pay").and_then(|v| v.as_str()).unwrap_or("");
                if is_qq_paid(pay) {
                    return None;
                }
                let mid = obj.get("song_mid")?.as_str()?.to_string();
                Some((mid, obj, pay.to_string()))
            })
            .take(limit as usize)
            .enumerate()
            .map(|(idx, (mid, obj, pay))| {
                let index = (idx + 1) as i32;
                Track {
                    uid: format!("qq-{mid}"),
                    source: MusicSourceId::Qq,
                    display_index: index,
                    keyword: keyword.to_string(),
                    song_id: mid.clone(),
                    song_mid: mid.clone(),
                    qq_id: mid,
                    qq_search_key: keyword.to_string(),
                    qq_index: index,
                    title: str_field(obj, "song_title"),
                    artist: str_field(obj, "singer_name"),
                    album: String::new(),
                    // Search payload has no cover fields; filled below via mid detail.
                    cover: None,
                    audio_url: None,
                    lrc: None,
                    lrc_url: None,
                    details_loaded: false,
                    quality: None,
                    quality_label: None,
                    pay: if pay.is_empty() { None } else { Some(pay) },
                }
            })
            .collect();

        // QQ search JSON only returns title/mid/artist; enrich covers in parallel.
        self.enrich_search_covers(keyword, &mut tracks).await;
        Ok(tracks)
    }

    async fn enrich_search_covers(&self, keyword: &str, tracks: &mut [Track]) {
        let mut set = JoinSet::new();
        for (idx, track) in tracks.iter().enumerate() {
            let base = self.base_url.clone();
            let mid = track.song_mid.clone();
            let msg = keyword.to_string();
            if mid.is_empty() {
                continue;
            }
            set.spawn(async move {
                let url = format!(
                    "{}?msg={}&type=json&mid={}",
                    base,
                    urlencoding::encode(&msg),
                    urlencoding::encode(&mid)
                );
                let body = get_text(&url).await.ok()?;
                let Value::Object(d) = serde_json::from_str(&body).ok()? else {
                    return None;
                };
                let cover = first_str(&d, &["album_pic", "singer_pic"]).map(prefer_https);
                let album = first_str(&d, &["album_name", "album_title"]).unwrap_or_default();
                Some((idx, cover, album))
            });
        }

        while let Some(joined) = set.join_next().await {
            let Ok(Some((idx, cover, album))) = joined else {
                continue;
            };
            if let Some(track) = tracks.get_mut(idx) {
                if track.cover.as_deref().unwrap_or("").is_empty() {
                    track.cover = cover;
                }
                if track.album.is_empty() && !album.is_empty() {
                    track.album = album;
                }
            }
        }
    }

    pub async fn fetch_details(&self, track: Track) -> Result<Track, String> {
        let msg = if !track.qq_search_key.is_empty() {
            track.qq_search_key.clone()
        } else if !track.keyword.is_empty() {
            track.keyword.clone()
        } else {
            format!("{} {}", track.title, track.artist).trim().to_string()
        };
        let mid = if !track.qq_id.is_empty() {
            track.qq_id.clone()
        } else if !track.song_mid.is_empty() {
            track.song_mid.clone()
        } else {
            track.song_id.clone()
        };
        if mid.is_empty() {
            return Ok(track);
        }

        let url = format!(
            "{}?msg={}&type=json&mid={}",
            self.base_url,
            urlencoding::encode(&msg),
            urlencoding::encode(&mid)
        );
        let body = get_text(&url).await?;
        let Ok(Value::Object(d)) = serde_json::from_str::<Value>(&body) else {
            return Ok(track);
        };
        if d.get("song_mid").and_then(|v| v.as_str()).unwrap_or("").is_empty() {
            return Ok(track);
        }

        let (url, tag, label) = pick_best_play_url(&d);
        let pay = first_str(&d, &["vip", "pay"]).or(track.pay.clone());
        let mut updated = Track {
            title: first_str(&d, &["song_title", "song_name"]).unwrap_or(track.title),
            artist: first_str(&d, &["singer_name"]).unwrap_or(track.artist),
            album: first_str(&d, &["album_name", "album_title"]).unwrap_or(track.album),
            cover: first_str(&d, &["album_pic", "singer_pic"])
                .map(prefer_https)
                .or(track.cover),
            audio_url: url.map(prefer_https).or(track.audio_url),
            lrc: first_str(&d, &["song_lyric", "lyric"]).or(track.lrc),
            quality: tag,
            quality_label: label,
            pay,
            details_loaded: true,
            ..track
        };

        if updated.quality.is_none() {
            let (q, l) = infer_quality_from_url(updated.audio_url.as_deref());
            updated.quality = q;
            updated.quality_label = l;
        }
        Ok(updated)
    }
}

fn pick_best_play_url(d: &Map<String, Value>) -> (Option<String>, Option<String>, Option<String>) {
    // Paid QQ songs often return empty strings for every play_url field.
    const CANDIDATES: &[(&str, &str, &str)] = &[
        ("song_play_url_sq", "lossless", "LOSSLESS"),
        ("song_play_url_pq", "lossless", "LOSSLESS"),
        ("song_play_url_accom", "hq", "HQ"),
        ("song_play_url_hq", "hq", "HQ"),
        ("song_play_url_standard", "standard", "STD"),
        ("song_play_url", "standard", "STD"),
        ("song_play_url_fq", "low", "LOW"),
    ];
    for (key, tag, label) in CANDIDATES {
        if let Some(url) = d.get(*key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()) {
            return (Some(url.to_string()), Some((*tag).into()), Some((*label).into()));
        }
    }
    (None, None, None)
}

fn str_field(obj: &Map<String, Value>, key: &str) -> String {
    obj.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn first_str(obj: &Map<String, Value>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| obj.get(*k).and_then(|v| v.as_str()).map(str::to_string))
}

fn prefer_https(url: String) -> String {
    if let Some(rest) = url.strip_prefix("http://") {
        format!("https://{rest}")
    } else {
        url
    }
}

fn is_qq_paid(pay: &str) -> bool {
    let lower = pay.trim().to_ascii_lowercase();
    lower.contains("付费") || lower.contains("vip") || lower == "1" || lower == "true"
}
