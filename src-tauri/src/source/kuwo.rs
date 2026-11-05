use serde_json::{Map, Value};

use crate::model::{infer_quality_from_url, AudioQuality, MusicSourceId, Track};

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
                    lrc_translation: None,
                    lrc_words: None,
                    details_loaded: false,
                    quality: None,
                    quality_label: None,
                    pay: None,
                })
            })
            .collect())
    }

    pub async fn fetch_details(
        &self,
        track: Track,
        quality: AudioQuality,
    ) -> Result<Track, String> {
        let mut out = track;
        // The oiapi detail endpoint is positional (`msg` search + `n`-th hit), so a
        // stored favourite resolves to whatever song now sits at that rank — that
        // is how clicking one track could start another. Confirm the rid first.
        let wanted = normalize_kuwo_music_id(&out.song_id);

        let mut payload = self
            .fetch_payload(&out.keyword, out.display_index.max(1), quality)
            .await
            .filter(|d| rid_matches(wanted.as_deref(), d));

        if payload.is_none() {
            if let Some(rid) = wanted.as_deref() {
                for msg in [format!("{} {}", out.title, out.artist), out.title.clone()] {
                    if msg.trim().is_empty() {
                        continue;
                    }
                    let Some(rank) = self.find_rank_by_rid(&msg, rid).await else {
                        continue;
                    };
                    payload = self
                        .fetch_payload(&msg, rank, quality)
                        .await
                        .filter(|d| rid_matches(Some(rid), d));
                    if payload.is_some() {
                        break;
                    }
                }
            }
        }

        if let Some(d) = payload {
            let audio_url = d
                .get("url")
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .or(out.audio_url.clone());
            let quality_text =
                format!("{} {}", str_field(&d, "level"), str_field(&d, "format")).to_lowercase();
            let (quality_id, quality_label) = if RegexLike::lossless(&quality_text) {
                (Some("lossless".into()), Some("LOSSLESS".into()))
            } else {
                infer_quality_from_url(audio_url.as_deref())
            };

            let song_id = opt_str(&d, "rid").unwrap_or(out.song_id.clone());
            let lrc = first_str(&d, &["lyric", "lrc", "lyrics"]).or(out.lrc.clone());
            out = Track {
                title: opt_str(&d, "song").unwrap_or(out.title),
                artist: opt_str(&d, "singer").unwrap_or(out.artist),
                album: opt_str(&d, "album").unwrap_or(out.album),
                cover: opt_str(&d, "picture").or(out.cover),
                song_id,
                audio_url,
                lrc,
                lrc_url: None,
                quality: quality_id,
                quality_label,
                ..out
            };
        } else if out.audio_url.as_deref().unwrap_or("").is_empty() {
            // Nothing could be confirmed, but Kuwo's anti-server resolves strictly
            // by rid — playing the right song at a lower bitrate beats the wrong one.
            if let Some(rid) = wanted.as_deref() {
                if let Some(url) = fetch_rid_url(rid).await {
                    let (quality_id, quality_label) = infer_quality_from_url(Some(&url));
                    out.audio_url = Some(url);
                    out.quality = quality_id;
                    out.quality_label = quality_label;
                }
            }
        }

        // oiapi detail often has no lyrics; always try Kuwo open API by musicId.
        if out.lrc.as_deref().unwrap_or("").is_empty() {
            if let Some(music_id) = normalize_kuwo_music_id(&out.song_id) {
                if let Some(lrc) = fetch_kuwo_lrc(&music_id).await {
                    out.lrc = Some(lrc);
                }
            }
        }

        out.details_loaded = true;
        Ok(out)
    }

    /// Detail lookup by search term and 1-based rank, preferring the requested
    /// quality. Returns the payload only when it actually carries an audio URL.
    async fn fetch_payload(
        &self,
        msg: &str,
        rank: i32,
        quality: AudioQuality,
    ) -> Option<Map<String, Value>> {
        // br=1 returns flac (often fails in WKWebView), br=320 mp3.
        // Lossless asks for flac first and falls back to mp3 when the API has none.
        let candidates: &[u32] = match quality {
            AudioQuality::Lossless => &[1, 320],
            AudioQuality::Hq => &[320],
            AudioQuality::Standard => &[320],
        };
        for br in candidates {
            let url = format!(
                "{}?msg={}&n={rank}&br={br}",
                self.base_url,
                urlencoding::encode(msg)
            );
            let Ok(body) = get_text(&url).await else {
                continue;
            };
            let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&body) else {
                continue;
            };
            if let Some(Value::Object(d)) = root.get("data") {
                if d.get("url").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).is_some() {
                    return Some(d.clone());
                }
            }
        }
        None
    }

    /// 1-based rank of the result carrying `rid`, so a title search can address
    /// one specific song instead of guessing by position.
    async fn find_rank_by_rid(&self, msg: &str, rid: &str) -> Option<i32> {
        let url = format!(
            "{}?msg={}&page=1&limit=20",
            self.base_url,
            urlencoding::encode(msg)
        );
        let body = get_text(&url).await.ok()?;
        let Value::Object(root) = serde_json::from_str::<Value>(&body).ok()? else {
            return None;
        };
        let Value::Array(data) = root.get("data")? else {
            return None;
        };
        data.iter()
            .position(|item| {
                item.get("rid")
                    .and_then(|v| v.as_str())
                    .and_then(normalize_kuwo_music_id)
                    .is_some_and(|r| r == rid)
            })
            .map(|i| i as i32 + 1)
    }
}

/// The rid a detail payload belongs to, normalized the same way as stored ids.
fn payload_rid(d: &Map<String, Value>) -> Option<String> {
    d.get("rid")
        .and_then(|v| v.as_str())
        .and_then(normalize_kuwo_music_id)
        .or_else(|| d.get("id").and_then(|v| v.as_u64()).map(|n| n.to_string()))
}

/// Treat a payload as the requested song; unverifiable ones keep old behaviour.
fn rid_matches(wanted: Option<&str>, d: &Map<String, Value>) -> bool {
    match wanted {
        None => true,
        Some(rid) => payload_rid(d).is_some_and(|r| r == rid),
    }
}

/// Exact rid → direct URL, used when no positional lookup could be confirmed.
async fn fetch_rid_url(rid: &str) -> Option<String> {
    let url = format!(
        "https://antiserver.kuwo.cn/anti.s?type=convert_url3&rid=MUSIC_{}&response=url",
        urlencoding::encode(rid)
    );
    let body = get_text(&url).await.ok()?;
    let Value::Object(root) = serde_json::from_str::<Value>(&body).ok()? else {
        return None;
    };
    let url = root.get("url").and_then(|v| v.as_str())?.trim();
    (!url.is_empty()).then(|| url.to_string())
}

fn normalize_kuwo_music_id(song_id: &str) -> Option<String> {
    let rid = song_id
        .trim()
        .trim_start_matches("MUSIC_")
        .trim_start_matches("music_")
        .trim();
    if rid.is_empty() {
        None
    } else {
        Some(rid.to_string())
    }
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
