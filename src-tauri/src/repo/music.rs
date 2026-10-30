use std::collections::HashMap;

use parking_lot::Mutex;
use tokio::task::JoinSet;

use crate::model::{MusicSourceId, SearchPageResult, SourceSearchError, Track};
use crate::source::MusicSources;

pub struct MusicRepository {
    cache: Mutex<HashMap<String, Track>>,
}

impl MusicRepository {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub async fn search(
        &self,
        sources: &MusicSources,
        keyword: &str,
        enabled: &[MusicSourceId],
        limit_per_source: u32,
        page: u32,
        reset: bool,
    ) -> Result<SearchPageResult, String> {
        let trimmed = keyword.trim();
        if trimmed.is_empty() {
            return Err("请输入关键词".into());
        }

        let enabled: Vec<MusicSourceId> = enabled
            .iter()
            .copied()
            .filter(|id| sources.has(*id))
            .collect();
        if enabled.is_empty() {
            return Err("请至少启用一个音源".into());
        }

        if reset {
            self.cache.lock().clear();
        }

        let mut set = JoinSet::new();
        for source in enabled {
            let keyword = trimmed.to_string();
            let sources = sources.clone();
            set.spawn(async move {
                match sources.search(source, &keyword, limit_per_source, page).await {
                    Ok(tracks) => (source, Ok(tracks)),
                    Err(message) => (source, Err(message)),
                }
            });
        }

        let mut errors = Vec::new();
        while let Some(joined) = set.join_next().await {
            match joined {
                Ok((_source, Ok(tracks))) => {
                    let mut cache = self.cache.lock();
                    for track in tracks {
                        cache.entry(track.uid.clone()).or_insert(track);
                    }
                }
                Ok((source, Err(message))) => {
                    errors.push(SourceSearchError { source, message });
                }
                Err(e) => {
                    eprintln!("search task join error: {e}");
                }
            }
        }

        let mut grouped: HashMap<MusicSourceId, Vec<Track>> = HashMap::new();
        {
            let cache = self.cache.lock();
            for track in cache.values() {
                grouped.entry(track.source).or_default().push(track.clone());
            }
        }
        for list in grouped.values_mut() {
            list.sort_by_key(|t| t.display_index);
        }

        Ok(SearchPageResult {
            tracks: interleave(&grouped),
            errors,
        })
    }

    pub async fn ensure_playable(&self, sources: &MusicSources, track: Track) -> Track {
        {
            let cache = self.cache.lock();
            if let Some(cached) = cache.get(&track.uid) {
                let has_audio = !cached.audio_url.as_deref().unwrap_or("").is_empty();
                let has_lrc = !cached.lrc.as_deref().unwrap_or("").is_empty();
                // Re-fetch when lyrics are still missing — local playback used to skip this.
                if cached.details_loaded && has_audio && has_lrc {
                    return cached.clone();
                }
            }
        }

        if !sources.has(track.source) {
            return track;
        }

        let detailed = sources.fetch_details(track.clone()).await.unwrap_or(track);
        self.cache
            .lock()
            .insert(detailed.uid.clone(), detailed.clone());
        detailed
    }
}

fn interleave(grouped: &HashMap<MusicSourceId, Vec<Track>>) -> Vec<Track> {
    let order = [
        MusicSourceId::Netease,
        MusicSourceId::Qq,
        MusicSourceId::Kuwo,
    ];
    let mut indices: HashMap<MusicSourceId, usize> = order.iter().map(|s| (*s, 0)).collect();
    let mut out = Vec::new();
    let mut added = true;
    while added {
        added = false;
        for source in &order {
            let list = grouped.get(source).map(|v| v.as_slice()).unwrap_or(&[]);
            let i = indices[source];
            if i < list.len() {
                out.push(list[i].clone());
                indices.insert(*source, i + 1);
                added = true;
            }
        }
    }
    out
}
