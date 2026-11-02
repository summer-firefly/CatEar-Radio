use std::collections::{HashMap, VecDeque};

use parking_lot::Mutex;
use tokio::task::JoinSet;

use crate::model::{AudioQuality, MusicSourceId, SearchPageResult, SourceSearchError, Track};
use crate::source::MusicSources;

/// Search results for one keyword page. Bounded so long sessions cannot grow
/// the heap without limit.
const SEARCH_CACHE_MAX: usize = 2000;
/// Tracks resolved with a play URL (i.e. actually played). Kept small because
/// each entry carries a signed URL and a full lyric.
const DETAILS_CACHE_MAX: usize = 300;

/// FIFO-bounded map. Plain `HashMap`s used to grow for the whole process life.
struct BoundedCache<V> {
    max: usize,
    order: VecDeque<String>,
    items: HashMap<String, V>,
}

impl<V> BoundedCache<V> {
    fn new(max: usize) -> Self {
        Self {
            max,
            order: VecDeque::new(),
            items: HashMap::new(),
        }
    }

    fn get(&self, key: &str) -> Option<&V> {
        self.items.get(key)
    }

    fn insert(&mut self, key: String, value: V) {
        if let Some(slot) = self.items.get_mut(&key) {
            *slot = value;
            return;
        }
        if self.items.len() >= self.max {
            // Evict in batches — one removal per insert is bookkeeping noise.
            let drop_n = (self.max / 4).max(1);
            for _ in 0..drop_n {
                if let Some(old) = self.order.pop_front() {
                    self.items.remove(&old);
                }
            }
        }
        self.order.push_back(key.clone());
        self.items.insert(key, value);
    }

    fn clear(&mut self) {
        self.items.clear();
        self.order.clear();
    }

    fn values(&self) -> impl Iterator<Item = &V> {
        self.items.values()
    }

    fn len(&self) -> usize {
        self.items.len()
    }
}

pub struct MusicRepository {
    cache: Mutex<BoundedCache<Track>>,
    /// Detailed tracks (with play URLs) keyed by `uid|quality`.
    details_cache: Mutex<BoundedCache<Track>>,
}

/// In-memory cache occupancy, surfaced to the settings page.
pub struct MemoryCacheStats {
    pub search_entries: usize,
    pub details_entries: usize,
}

impl MusicRepository {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(BoundedCache::new(SEARCH_CACHE_MAX)),
            details_cache: Mutex::new(BoundedCache::new(DETAILS_CACHE_MAX)),
        }
    }

    pub fn stats(&self) -> MemoryCacheStats {
        MemoryCacheStats {
            search_entries: self.cache.lock().len(),
            details_entries: self.details_cache.lock().len(),
        }
    }

    /// Drop both in-memory caches; playback re-resolves URLs on demand.
    pub fn clear(&self) {
        self.cache.lock().clear();
        self.details_cache.lock().clear();
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
                        if cache.get(&track.uid).is_none() {
                            cache.insert(track.uid.clone(), track);
                        }
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

    pub async fn ensure_playable(
        &self,
        sources: &MusicSources,
        track: Track,
        quality: AudioQuality,
    ) -> Track {
        let key = format!("{}|{}", track.uid, quality.id());
        {
            let cache = self.details_cache.lock();
            if let Some(cached) = cache.get(&key) {
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

        let detailed = sources
            .fetch_details(track.clone(), quality)
            .await
            .unwrap_or(track);
        self.details_cache
            .lock()
            .insert(key, detailed.clone());
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
