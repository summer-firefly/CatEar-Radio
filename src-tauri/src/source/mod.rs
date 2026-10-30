mod config;
mod kuwo;
mod netease;
mod qq;

pub use config::{ensure_builtin_sources, SourceManifest, SourceRegistry};
pub use kuwo::KuwoMusicSource;
pub use netease::NeteaseMusicSource;
pub use qq::QqMusicSource;

use std::collections::HashMap;

use crate::model::{AudioQuality, MusicSourceId, Track};

#[derive(Clone, Default)]
pub struct MusicSources {
    base_urls: HashMap<MusicSourceId, String>,
}

impl MusicSources {
    pub fn from_registry(registry: &SourceRegistry) -> Self {
        let mut base_urls = HashMap::new();
        for id in MusicSourceId::all() {
            if let Some(url) = registry.base_url(*id) {
                base_urls.insert(*id, url);
            }
        }
        Self { base_urls }
    }

    pub fn has(&self, source: MusicSourceId) -> bool {
        self.base_urls.contains_key(&source)
    }

    fn require_base(&self, source: MusicSourceId) -> Result<&str, String> {
        self.base_urls
            .get(&source)
            .map(|s| s.as_str())
            .ok_or_else(|| format!("音源未配置：{}", source.label()))
    }

    pub async fn search(
        &self,
        source: MusicSourceId,
        keyword: &str,
        limit: u32,
        page: u32,
    ) -> Result<Vec<Track>, String> {
        let base = self.require_base(source)?;
        match source {
            MusicSourceId::Netease => {
                NeteaseMusicSource::new(base).search(keyword, limit, page).await
            }
            MusicSourceId::Qq => QqMusicSource::new(base).search(keyword, limit, page).await,
            MusicSourceId::Kuwo => KuwoMusicSource::new(base).search(keyword, limit, page).await,
            // Local tracks come from the filesystem scan, not a network source.
            MusicSourceId::Local => Err("本地音源不支持网络搜索".into()),
        }
    }

    pub async fn fetch_details(
        &self,
        track: Track,
        quality: AudioQuality,
    ) -> Result<Track, String> {
        let base = self.require_base(track.source)?;
        match track.source {
            MusicSourceId::Netease => {
                NeteaseMusicSource::new(base)
                    .fetch_details(track, quality)
                    .await
            }
            MusicSourceId::Qq => QqMusicSource::new(base).fetch_details(track, quality).await,
            MusicSourceId::Kuwo => KuwoMusicSource::new(base).fetch_details(track, quality).await,
            MusicSourceId::Local => Ok(track),
        }
    }
}

pub(crate) fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("MaoerRadio/0.1")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .expect("http client")
}

pub(crate) async fn get_text(url: &str) -> Result<String, String> {
    let resp = http_client()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("http {}", resp.status()));
    }
    resp.text().await.map_err(|e| e.to_string())
}
