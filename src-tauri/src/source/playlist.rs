//! Import a shared NetEase / QQ Music playlist from its share link.

use serde_json::Value;

use crate::model::{MusicSourceId, Track};

use super::{get_text, get_text_with_referer, resolve_final_url};

pub struct PlaylistLink {
    pub source: MusicSourceId,
    pub id: String,
}

/// Accept a bare URL or the whole share text ("分享歌单: https://…").
fn extract_url(input: &str) -> Option<String> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }
    let start = text.find("http").unwrap_or(0);
    let rest = &text[start..];
    let end = rest
        .find(|c: char| c.is_whitespace() || c == '，' || c == '。')
        .unwrap_or(rest.len());
    let url = &rest[..end];
    if url.len() < 8 {
        return None;
    }
    Some(url.to_string())
}

fn split_host(url: &str) -> Option<(&str, &str)> {
    let after_scheme = url.split_once("://").map(|(_, rest)| rest)?;
    let end = after_scheme.find('/').unwrap_or(after_scheme.len());
    Some((&after_scheme[..end], &after_scheme[end..]))
}

fn query_param(url: &str, key: &str) -> Option<String> {
    for prefix in ['?', '&'] {
        let needle = format!("{prefix}{key}=");
        if let Some(idx) = url.find(&needle) {
            let start = idx + needle.len();
            let end = url[start..]
                .find(['&', '#'])
                .map(|i| start + i)
                .unwrap_or(url.len());
            let value = url[start..end].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// `/playlist/7150801721` → `7150801721`; the bare `/playlist?id=` form is handled separately.
fn path_id_after(url: &str, marker: &str) -> Option<String> {
    let idx = url.find(marker)?;
    let rest = url[idx + marker.len()..].strip_prefix('/')?;
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let id = rest[..end].trim();
    (!id.is_empty()).then(|| id.to_string())
}

fn only_digits(id: &str) -> Option<String> {
    let trimmed = id.trim();
    (!trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()))
        .then(|| trimmed.to_string())
}

fn parse_url(url: &str) -> Option<PlaylistLink> {
    let (host, _) = split_host(url)?;
    let host = host.to_ascii_lowercase();
    if host.ends_with("music.163.com") {
        let id = query_param(url, "id").or_else(|| path_id_after(url, "/playlist"))?;
        return Some(PlaylistLink {
            source: MusicSourceId::Netease,
            id: only_digits(&id).unwrap_or(id),
        });
    }
    if host.ends_with("qq.com") || host.ends_with("qqmusic.qq.com") {
        let id = query_param(url, "id")
            .or_else(|| query_param(url, "disstid"))
            .or_else(|| path_id_after(url, "/playlist"))?;
        return Some(PlaylistLink {
            source: MusicSourceId::Qq,
            id: only_digits(&id).unwrap_or(id),
        });
    }
    None
}

fn is_short_link(url: &str) -> bool {
    split_host(url)
        .map(|(host, _)| {
            let host = host.to_ascii_lowercase();
            host == "163cn.tv" || host.ends_with(".163cn.tv")
        })
        .unwrap_or(false)
}

/// Resolve a user-pasted share link into a platform + playlist id.
pub async fn resolve_link(input: &str) -> Result<PlaylistLink, String> {
    let raw = extract_url(input).ok_or_else(|| "请粘贴歌单分享链接".to_string())?;
    let mut url = if raw.starts_with("http://") || raw.starts_with("https://") {
        raw
    } else {
        format!("https://{raw}")
    };
    if is_short_link(&url) {
        url = resolve_final_url(&url).await?;
    }
    parse_url(&url).ok_or_else(|| {
        "无法识别该链接，请使用网易云或 QQ 音乐的歌单分享链接".to_string()
    })
}

/// Track list straight from the meting mirror — works for both platforms.
pub async fn fetch_tracks(
    link: &PlaylistLink,
    meting_base: &str,
    limit: usize,
) -> Result<Vec<Track>, String> {
    let server = match link.source {
        MusicSourceId::Qq => "tencent",
        _ => "netease",
    };
    let url = format!(
        "{meting_base}?type=playlist&id={}&server={server}",
        urlencoding::encode(&link.id)
    );
    let body = get_text(&url).await?;
    let mut tracks = match link.source {
        MusicSourceId::Qq => parse_qq_tracks(&body),
        _ => parse_netease_tracks(&body, &link.id),
    };
    if tracks.is_empty() {
        return Err("歌单为空或该链接暂不可用".into());
    }
    tracks.truncate(limit);
    Ok(tracks)
}

fn value_str(obj: &serde_json::Map<String, Value>, key: &str) -> String {
    obj.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn parse_netease_tracks(body: &str, playlist_id: &str) -> Vec<Track> {
    let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    arr.iter()
        .enumerate()
        .filter_map(|(idx, el)| {
            let obj = el.as_object()?;
            let audio_url = obj.get("url").and_then(|v| v.as_str()).map(str::to_string);
            let song_id = audio_url
                .as_deref()
                .and_then(|u| query_param(u, "id"))
                .unwrap_or_else(|| format!("{playlist_id}-{}", idx + 1));
            Some(Track {
                uid: format!("netease-{song_id}"),
                source: MusicSourceId::Netease,
                display_index: (idx + 1) as i32,
                keyword: value_str(obj, "name"),
                song_id,
                song_mid: String::new(),
                qq_id: String::new(),
                qq_search_key: String::new(),
                qq_index: 0,
                title: value_str(obj, "name"),
                artist: value_str(obj, "artist"),
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
                lrc_translation: None,
                lrc_words: None,
                details_loaded: false,
                quality: None,
                quality_label: None,
                pay: None,
            })
        })
        .collect()
}

fn parse_qq_tracks(body: &str) -> Vec<Track> {
    let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(body) else {
        return Vec::new();
    };
    arr.iter()
        .enumerate()
        .filter_map(|(idx, el)| {
            let obj = el.as_object()?;
            let audio_url = obj.get("url").and_then(|v| v.as_str()).map(str::to_string);
            // QQ entries carry the song mid, not a numeric id.
            let mid = audio_url
                .as_deref()
                .and_then(|u| query_param(u, "id"))
                .unwrap_or_default();
            if mid.is_empty() {
                return None;
            }
            let title = value_str(obj, "name");
            Some(Track {
                uid: format!("qq-{mid}"),
                source: MusicSourceId::Qq,
                display_index: (idx + 1) as i32,
                keyword: title.clone(),
                song_id: mid.clone(),
                song_mid: mid.clone(),
                qq_id: mid,
                qq_search_key: title.clone(),
                qq_index: (idx + 1) as i32,
                title,
                artist: value_str(obj, "artist"),
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
                lrc_translation: None,
                lrc_words: None,
                details_loaded: false,
                quality: None,
                quality_label: None,
                pay: None,
            })
        })
        .collect()
}

/// Playlist name from the platform itself; the caller falls back to a generic one.
pub async fn fetch_title(link: &PlaylistLink) -> Option<String> {
    match link.source {
        MusicSourceId::Qq => {
            let url = format!(
                "https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid={}&format=json",
                urlencoding::encode(&link.id)
            );
            let body = get_text_with_referer(&url, "https://y.qq.com/").await.ok()?;
            let value: Value = serde_json::from_str(&body).ok()?;
            value
                .get("cdlist")?
                .get(0)?
                .get("dissname")?
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        }
        _ => {
            let url = format!(
                "https://music.163.com/api/v6/playlist/detail?id={}",
                urlencoding::encode(&link.id)
            );
            let body = get_text(&url).await.ok()?;
            let value: Value = serde_json::from_str(&body).ok()?;
            value
                .get("playlist")?
                .get("name")?
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{parse_netease_tracks, parse_qq_tracks, parse_url, MusicSourceId};

    #[test]
    fn parses_netease_links() {
        let link = parse_url("https://music.163.com/playlist?id=3778678&userid=1").unwrap();
        assert_eq!(link.source, MusicSourceId::Netease);
        assert_eq!(link.id, "3778678");

        let hash = parse_url("https://music.163.com/#/playlist?id=24381616").unwrap();
        assert_eq!(hash.id, "24381616");
    }

    #[test]
    fn parses_qq_links() {
        let desktop = parse_url("https://y.qq.com/n/ryqq/playlist/7150801721").unwrap();
        assert_eq!(desktop.source, MusicSourceId::Qq);
        assert_eq!(desktop.id, "7150801721");

        let mobile =
            parse_url("https://i.y.qq.com/n2/m/share/details/taoge.html?id=7150801721").unwrap();
        assert_eq!(mobile.id, "7150801721");
    }

    #[test]
    fn rejects_unrelated_links() {
        assert!(parse_url("https://example.com/playlist?id=1").is_none());
        assert!(parse_url("https://y.qq.com/n/ryqq/songDetail/abc").is_none());
    }

    #[test]
    fn parses_netease_payload_into_tracks() {
        let body = r#"[{"name":"晴天","artist":"周杰伦","url":"https://api.qijieya.cn/meting/?server=netease&type=url&id=186016","pic":"https://p1.music.126.net/a.jpg","lrc":"https://api.qijieya.cn/meting/?server=netease&type=lrc&id=186016"}]"#;
        let tracks = parse_netease_tracks(body, "3778678");
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].uid, "netease-186016");
        assert_eq!(tracks[0].title, "晴天");
        assert_eq!(tracks[0].source, MusicSourceId::Netease);
    }

    #[test]
    fn parses_qq_payload_into_mid_tracks() {
        let body = r#"[{"name":"珊瑚海","artist":"July-七七","url":"https://api.qijieya.cn/meting/?server=tencent&type=url&id=0013B9Bp4dElSd","pic":"https://api.qijieya.cn/meting/?server=tencent&type=pic&id=000ldcea3drm8h"}]"#;
        let tracks = parse_qq_tracks(body);
        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].uid, "qq-0013B9Bp4dElSd");
        assert_eq!(tracks[0].song_mid, "0013B9Bp4dElSd");
        assert_eq!(tracks[0].qq_id, "0013B9Bp4dElSd");
        assert_eq!(tracks[0].source, MusicSourceId::Qq);
    }
}
