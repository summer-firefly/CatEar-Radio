use serde_json::Value;

use crate::model::{infer_quality_from_url, MusicSourceId, Track};

use super::get_text;

pub struct NeteaseMusicSource {
    base_url: String,
}

impl NeteaseMusicSource {
    pub fn new(base_url: impl Into<String>) -> Self {
        let base = base_url.into();
        let base_url = base.trim().trim_end_matches('/').to_string();
        Self { base_url }
    }

    pub async fn search(&self, keyword: &str, limit: u32, page: u32) -> Result<Vec<Track>, String> {
        let request_limit = page.max(1) * limit.max(1);
        let url = format!(
            "{}?type=search&id={}&limit={request_limit}&server=netease",
            self.base_url,
            urlencoding::encode(keyword)
        );
        let body = get_text(&url).await?;
        Ok(parse_track_list(&body, keyword))
    }

    pub async fn fetch_playlist(&self, playlist_id: &str, limit: u32) -> Result<Vec<Track>, String> {
        let url = format!(
            "{}?type=playlist&id={}&server=netease",
            self.base_url,
            urlencoding::encode(playlist_id)
        );
        let body = get_text(&url).await?;
        let mut tracks = parse_track_list(&body, &format!("playlist:{playlist_id}"));
        tracks.truncate(limit.max(1) as usize);
        Ok(tracks)
    }

    pub async fn fetch_details(&self, mut track: Track) -> Result<Track, String> {
        if !track.song_id.is_empty() {
            if track.audio_url.as_deref().unwrap_or("").is_empty() {
                track.audio_url = Some(format!(
                    "{}?server=netease&type=url&id={}",
                    self.base_url,
                    urlencoding::encode(&track.song_id)
                ));
            }
            if track.lrc_url.as_deref().unwrap_or("").is_empty() {
                track.lrc_url = Some(format!(
                    "{}?server=netease&type=lrc&id={}",
                    self.base_url,
                    urlencoding::encode(&track.song_id)
                ));
            }
        }

        let (q, label) = infer_quality_from_url(track.audio_url.as_deref());
        track.quality = q;
        track.quality_label = label;

        if track.lrc.as_deref().unwrap_or("").is_empty() {
            if let Some(lrc_url) = track.lrc_url.clone() {
                if let Ok(body) = get_text(&lrc_url).await {
                    if let Some(lyric) = parse_lyric_payload(&body) {
                        track.lrc = Some(lyric);
                    }
                }
            }
        }

        track.details_loaded = true;
        Ok(track)
    }
}

fn parse_track_list(body: &str, keyword_fallback: &str) -> Vec<Track> {
    let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };

    arr.iter()
        .enumerate()
        .filter_map(|(idx, el)| {
            let obj = el.as_object()?;
            let audio_url = obj.get("url").and_then(|v| v.as_str()).map(str::to_string);
            let song_id = pick_query_param(audio_url.as_deref(), "id")
                .unwrap_or_else(|| format!("{}-{}", keyword_fallback, idx + 1));
            Some(Track {
                uid: format!("netease-{song_id}"),
                source: MusicSourceId::Netease,
                display_index: (idx + 1) as i32,
                keyword: keyword_fallback.to_string(),
                song_id,
                song_mid: String::new(),
                qq_id: String::new(),
                qq_search_key: String::new(),
                qq_index: 0,
                title: str_field(obj, "name"),
                artist: str_field(obj, "artist"),
                album: String::new(),
                cover: obj
                    .get("pic")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                audio_url,
                lrc: None,
                lrc_url: obj
                    .get("lrc")
                    .and_then(|v| v.as_str())
                    .map(str::to_string),
                details_loaded: false,
                quality: None,
                quality_label: None,
                pay: None,
            })
        })
        .collect()
}

fn parse_lyric_payload(body: &str) -> Option<String> {
    let trimmed = body.trim();
    if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
        return Some(trimmed.to_string());
    }
    let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
        return trimmed.contains('[').then(|| trimmed.to_string());
    };
    if value.is_array() {
        return None;
    }
    let obj = value.as_object()?;
    if let Some(s) = obj
        .get("lrc")
        .or_else(|| obj.get("lyric"))
        .and_then(|v| v.as_str())
    {
        return Some(s.to_string());
    }
    if let Some(data) = obj.get("data") {
        if let Some(s) = data.as_str() {
            return Some(s.to_string());
        }
        if let Some(inner) = data.as_object() {
            if let Some(s) = inner
                .get("lrc")
                .or_else(|| inner.get("lyric"))
                .and_then(|v| v.as_str())
            {
                return Some(s.to_string());
            }
        }
    }
    trimmed.contains('[').then(|| trimmed.to_string())
}

fn pick_query_param(raw_url: Option<&str>, key: &str) -> Option<String> {
    let url = raw_url?;
    let needle = format!("{key}=");
    let idx = url.find(&needle)?;
    let start = idx + needle.len();
    let end = url[start..]
        .find('&')
        .map(|i| start + i)
        .unwrap_or(url.len());
    let raw = &url[start..end];
    Some(urlencoding::decode(raw).unwrap_or_else(|_| raw.into()).into_owned())
}

fn str_field(obj: &serde_json::Map<String, Value>, key: &str) -> String {
    obj.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}
