use serde::{Deserialize, Serialize};

/// Public repository that hosts the release artifacts.
const RELEASES_API: &str = "https://api.github.com/repos/summer-firefly/CatEar-Radio/releases/latest";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub has_update: bool,
    pub url: String,
    pub notes: String,
}

#[derive(Debug, Deserialize)]
struct Release {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    body: String,
}

/// Compare dotted versions numerically; non-numeric suffixes are ignored so
/// `0.3.0-beta.1` still compares as `0.3.0`.
fn parts(version: &str) -> Vec<u32> {
    version
        .trim()
        .trim_start_matches(['v', 'V'])
        .split('.')
        .map(|part| {
            part.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
                .parse()
                .unwrap_or(0)
        })
        .collect()
}

fn is_newer(latest: &str, current: &str) -> bool {
    let a = parts(latest);
    let b = parts(current);
    for i in 0..a.len().max(b.len()) {
        let left = a.get(i).copied().unwrap_or(0);
        let right = b.get(i).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

/// Ask GitHub for the newest release. Networking failures are surfaced as
/// errors so the UI can tell "up to date" apart from "could not check".
#[tauri::command]
pub async fn check_update() -> Result<UpdateInfo, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    let body = crate::source::get_text(RELEASES_API).await?;
    let release: Release = serde_json::from_str(&body).map_err(|e| format!("解析更新信息失败：{e}"))?;
    if release.tag_name.is_empty() {
        return Err("未找到发布版本".into());
    }
    let latest = release.tag_name.trim_start_matches(['v', 'V']).to_string();
    Ok(UpdateInfo {
        has_update: is_newer(&latest, &current),
        current,
        latest,
        url: release.html_url,
        notes: release.body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("v1.0.0", "0.99.99"));
        assert!(is_newer("0.2.1", "0.2.0"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("0.1.9", "0.2.0"));
    }

    #[test]
    fn ignores_prerelease_suffixes() {
        assert_eq!(parts("0.3.0-beta.1"), vec![0, 3, 0, 1]);
        assert!(is_newer("0.3.0-beta.1", "0.2.9"));
    }
}
