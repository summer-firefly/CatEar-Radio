use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::{MusicSourceId, SourceInfo};

/// Bundled defaults from `resources/sources/`.
const BUILTIN_SOURCES: &[(&str, &str)] = &[
    ("netease", include_str!("../../resources/sources/netease.json")),
    ("qq", include_str!("../../resources/sources/qq.json")),
    ("kuwo", include_str!("../../resources/sources/kuwo.json")),
];

/// Write missing builtin manifests into the sources dir. Does not overwrite imports.
/// Returns ids that were newly written.
pub fn ensure_builtin_sources(dir: impl AsRef<Path>) -> Vec<MusicSourceId> {
    let dir = dir.as_ref();
    let _ = fs::create_dir_all(dir);
    let mut written = Vec::new();
    for (_id, text) in BUILTIN_SOURCES {
        let Ok(manifest) = SourceManifest::parse_json(text) else {
            continue;
        };
        let Some(id) = manifest.source_id() else {
            continue;
        };
        let path = dir.join(format!("{}.json", id.id()));
        if path.exists() {
            continue;
        }
        let Ok(json) = serde_json::to_string_pretty(&manifest) else {
            continue;
        };
        if fs::write(&path, json).is_ok() {
            written.push(id);
        }
    }
    written
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceManifest {
    pub id: String,
    pub label: String,
    pub driver: String,
    pub base_url: String,
}

impl SourceManifest {
    pub fn source_id(&self) -> Option<MusicSourceId> {
        MusicSourceId::try_from_id(&self.id).or_else(|| MusicSourceId::try_from_id(&self.driver))
    }

    pub fn parse_json(text: &str) -> Result<Self, String> {
        let m: Self = serde_json::from_str(text).map_err(|e| format!("音源 JSON 无效：{e}"))?;
        let id = m
            .source_id()
            .ok_or_else(|| "不支持的音源，id/driver 需为 netease、qq 或 kuwo".to_string())?;
        if m.base_url.trim().is_empty() {
            return Err("音源缺少 baseUrl".into());
        }
        if m.label.trim().is_empty() {
            return Err("音源缺少 label".into());
        }
        Ok(Self {
            id: id.id().to_string(),
            label: m.label.trim().to_string(),
            driver: id.id().to_string(),
            base_url: m.base_url.trim().trim_end_matches('/').to_string(),
        })
    }

    pub fn to_info(&self) -> Option<SourceInfo> {
        Some(SourceInfo {
            id: self.source_id()?,
            label: self.label.clone(),
        })
    }
}

#[derive(Debug, Clone, Default)]
pub struct SourceRegistry {
    manifests: Vec<SourceManifest>,
}

impl SourceRegistry {
    pub fn load(dir: impl Into<PathBuf>) -> Self {
        let dir = dir.into();
        let mut manifests = Vec::new();
        if dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&dir) {
                let mut files: Vec<PathBuf> = entries
                    .flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.extension()
                            .and_then(|e| e.to_str())
                            .map(|e| e.eq_ignore_ascii_case("json"))
                            .unwrap_or(false)
                    })
                    .collect();
                files.sort();
                for path in files {
                    if let Ok(text) = fs::read_to_string(&path) {
                        if let Ok(m) = serde_json::from_str::<SourceManifest>(&text) {
                            if !m.base_url.trim().is_empty() && m.source_id().is_some() {
                                manifests.push(m);
                            }
                        }
                    }
                }
            }
        }
        Self { manifests }
    }

    pub fn list_info(&self) -> Vec<SourceInfo> {
        self.manifests
            .iter()
            .filter_map(|m| {
                let id = m.source_id()?;
                Some(SourceInfo {
                    id,
                    label: m.label.clone(),
                })
            })
            .collect()
    }

    pub fn base_url(&self, id: MusicSourceId) -> Option<String> {
        self.manifests
            .iter()
            .find(|m| m.source_id() == Some(id))
            .map(|m| m.base_url.trim().trim_end_matches('/').to_string())
            .filter(|u| !u.is_empty())
    }
}
