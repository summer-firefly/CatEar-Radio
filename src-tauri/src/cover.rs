use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::storage::write_atomic;

/// Small square thumbnail suitable for lists, and the larger one used by the
/// now-playing panel. Keeping them separate means a 40px row never pulls a
/// 800px JPEG over the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CoverVariant {
    Thumb,
    Full,
}

impl CoverVariant {
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "full" => Self::Full,
            _ => Self::Thumb,
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Self::Thumb => "s",
            Self::Full => "l",
        }
    }
}

/// Rewrite known CDN cover URLs to ask for a smaller render. Sources that do not
/// document a size parameter are left untouched — the cache still helps there.
pub fn sized_cover_url(url: &str, variant: CoverVariant) -> String {
    let lower = url.to_lowercase();
    // Netease's CDN charges a lot for large renders (500px takes ~13s vs
    // ~1.8s for 130px), and nothing in the UI draws wider than 160px.
    let side = match variant {
        CoverVariant::Thumb => 130,
        CoverVariant::Full => 300,
    };

    // Netease image CDN: `?param=300y300` controls the rendered size.
    if lower.contains("music.126.net") || lower.contains("126.net") {
        let base = url.split('?').next().unwrap_or(url);
        return format!("{base}?param={side}y{side}");
    }
    // Kuwo album art encodes the size in the path: /albumcover/800/...
    if lower.contains("kuwo.cn") {
        let with_size = replace_albumcover_size(url, side);
        if with_size != url {
            return with_size;
        }
    }
    url.to_string()
}

/// `/star/albumcover/800/xxxx` → `/star/albumcover/130/xxxx`
fn replace_albumcover_size(url: &str, side: u32) -> String {
    let Some(idx) = url.find("/albumcover/") else {
        return url.to_string();
    };
    let start = idx + "/albumcover/".len();
    let rest = &url[start..];
    let Some(end) = rest.find('/') else {
        return url.to_string();
    };
    let current = &rest[..end];
    if current.parse::<u32>().is_err() {
        return url.to_string();
    }
    format!("{}/albumcover/{}{}", &url[..idx], side, &rest[end..])
}

fn hash_key(url: &str) -> String {
    // FNV-1a: tiny, dependency-free, and stable across runs.
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in url.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn cache_path(dir: &Path, url: &str, variant: CoverVariant) -> PathBuf {
    dir.join(format!("{}-{}.img", hash_key(url), variant.suffix()))
}

fn sniff_ext(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "png"
    } else if bytes.starts_with(&[0xff, 0xd8]) {
        "jpg"
    } else if bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "webp"
    } else if bytes.starts_with(b"GIF8") {
        "gif"
    } else {
        "bin"
    }
}

/// Read a cached cover, if present.
pub fn read_cached(dir: &Path, url: &str, variant: CoverVariant) -> Option<(Vec<u8>, &'static str)> {
    let path = cache_path(dir, url, variant);
    let bytes = fs::read(&path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let ext = sniff_ext(&bytes);
    Some((bytes, ext))
}

/// Download and persist a cover. Concurrent callers may race, but the write is
/// atomic so the loser just overwrites with identical bytes.
pub async fn fetch_and_cache(
    dir: &Path,
    url: &str,
    variant: CoverVariant,
) -> Result<(Vec<u8>, &'static str), String> {
    let resp = crate::source::http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
    if bytes.is_empty() {
        return Err("空封面".into());
    }
    let _ = write_atomic(&cache_path(dir, url, variant), &bytes);
    let ext = sniff_ext(&bytes);
    Ok((bytes, ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn netease_urls_get_a_size_param() {
        let url = "https://p3.music.126.net/abc==/123.jpg";
        assert_eq!(
            sized_cover_url(url, CoverVariant::Thumb),
            "https://p3.music.126.net/abc==/123.jpg?param=130y130"
        );
        assert_eq!(
            sized_cover_url("https://p1.music.126.net/a.jpg?param=800y800", CoverVariant::Full),
            "https://p1.music.126.net/a.jpg?param=300y300"
        );
    }

    #[test]
    fn kuwo_urls_swap_the_albumcover_segment() {
        let url = "https://img3.kuwo.cn/star/albumcover/800/s3s94/93/211513640.jpg";
        assert_eq!(
            sized_cover_url(url, CoverVariant::Thumb),
            "https://img3.kuwo.cn/star/albumcover/130/s3s94/93/211513640.jpg"
        );
    }

    #[test]
    fn unknown_urls_are_left_alone() {
        let url = "https://example.com/cover.jpg";
        assert_eq!(sized_cover_url(url, CoverVariant::Thumb), url);
    }

    #[test]
    fn hash_is_stable_and_varies_by_url() {
        assert_eq!(hash_key("a"), hash_key("a"));
        assert_ne!(hash_key("a"), hash_key("b"));
    }

    #[test]
    fn sniff_detects_common_formats() {
        assert_eq!(sniff_ext(&[0xff, 0xd8, 0x00]), "jpg");
        assert_eq!(sniff_ext(&[0x89, b'P', b'N', b'G']), "png");
        assert_eq!(sniff_ext(b"RIFF0000WEBPVP8"), "webp");
    }
}
