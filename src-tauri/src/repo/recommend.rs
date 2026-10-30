use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::task::JoinSet;

use crate::model::{RecommendCatalog, RecommendPlaylist, Track};
use crate::source::NeteaseMusicSource;

struct ChartPlaylist {
    id: &'static str,
    name: &'static str,
    subtitle: &'static str,
}

const CHARTS: &[ChartPlaylist] = &[
    ChartPlaylist {
        id: "3778678",
        name: "热歌榜",
        subtitle: "网易云 · 近期热门",
    },
    ChartPlaylist {
        id: "3779629",
        name: "新歌榜",
        subtitle: "网易云 · 最新单曲",
    },
    ChartPlaylist {
        id: "19723756",
        name: "飙升榜",
        subtitle: "网易云 · 快速上升",
    },
    ChartPlaylist {
        id: "2884035",
        name: "原创榜",
        subtitle: "网易云 · 原创精选",
    },
];

/// Background sync interval for recommendation cache.
const SYNC_INTERVAL: Duration = Duration::from_secs(10 * 60);

#[derive(Clone)]
struct CacheState {
    catalog: RecommendCatalog,
    updated_at_ms: Option<i64>,
    /// Monotonic sync id — only the latest in-flight fetch may commit.
    generation: u64,
}

pub struct RecommendRepository {
    path: PathBuf,
    state: Mutex<CacheState>,
}

impl RecommendRepository {
    pub fn load(path: PathBuf) -> Arc<Self> {
        let catalog = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<RecommendCatalog>(&s).ok())
            .unwrap_or_default();
        let updated_at_ms = fs::metadata(&path)
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64);

        Arc::new(Self {
            path,
            state: Mutex::new(CacheState {
                catalog,
                updated_at_ms,
                generation: 0,
            }),
        })
    }

    /// Instant local read — never hits the network.
    pub fn get(&self) -> RecommendCatalog {
        self.state.lock().catalog.clone()
    }

    pub fn start_background_sync(self: &Arc<Self>, app: AppHandle) {
        let this = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            // First sync soon after launch — emit so UI can update quietly.
            let _ = this.sync_once(&app, true).await;
            loop {
                tokio::time::sleep(SYNC_INTERVAL).await;
                let _ = this.sync_once(&app, true).await;
            }
        });
    }

    /// User-facing refresh: network fetch, return via IPC (no event — avoids double paint).
    pub async fn refresh(&self, app: &AppHandle) -> Result<RecommendCatalog, String> {
        self.sync_once(app, false).await
    }

    /// Starts a new fetch generation. Stale overlapping fetches are discarded.
    /// `emit_event`: background sync notifies UI; user refresh returns data via IPC only.
    async fn sync_once(&self, app: &AppHandle, emit_event: bool) -> Result<RecommendCatalog, String> {
        let my_gen = {
            let mut guard = self.state.lock();
            guard.generation = guard.generation.wrapping_add(1);
            guard.generation
        };

        let result = async {
            let base = Self::resolve_netease_base(app)
                .ok_or_else(|| "请先启用并配置网易云音源".to_string())?;
            let catalog = Self::fetch_pool(&base, 40).await;
            if catalog.hot_tracks.is_empty() && catalog.hot_playlists.is_empty() {
                return Err("推荐同步失败，未获取到数据".into());
            }
            Ok(catalog)
        }
        .await;

        match result {
            Ok(catalog) => {
                let mut guard = self.state.lock();
                if my_gen != guard.generation {
                    // A newer refresh superseded this fetch — keep latest, don't emit.
                    return Ok(guard.catalog.clone());
                }
                guard.catalog = catalog.clone();
                guard.updated_at_ms = Some(now_ms());
                if let Ok(json) = serde_json::to_string(&catalog) {
                    let _ = crate::storage::write_atomic(&self.path, json.as_bytes());
                }
                drop(guard);
                if emit_event {
                    let _ = app.emit("recommend-updated", catalog.clone());
                }
                Ok(catalog)
            }
            Err(e) => Err(e),
        }
    }

    fn resolve_netease_base(app: &AppHandle) -> Option<String> {
        use crate::model::MusicSourceId;
        use crate::source::{ensure_builtin_sources, SourceRegistry};
        use crate::state::AppState;
        use tauri::Manager;

        let state = app.try_state::<AppState>()?;
        let settings = state.settings.get();
        if !settings.enabled_sources.contains(&MusicSourceId::Netease) {
            return None;
        }
        let dir = crate::paths::resolve_sources_dir(app, &settings);
        ensure_builtin_sources(&dir);
        let registry = SourceRegistry::load(dir);
        registry.base_url(MusicSourceId::Netease)
    }

    async fn fetch_pool(base_url: &str, pool_limit_per_chart: u32) -> RecommendCatalog {
        let mut set = JoinSet::new();
        for chart in CHARTS {
            let id = chart.id;
            let name = chart.name;
            let subtitle = chart.subtitle;
            let base_url = base_url.to_string();
            set.spawn(async move {
                let netease = NeteaseMusicSource::new(base_url);
                let tracks = netease
                    .fetch_playlist(id, pool_limit_per_chart)
                    .await
                    .unwrap_or_default();
                (id, name, subtitle, tracks)
            });
        }

        let mut by_id: std::collections::HashMap<String, (String, String, Vec<Track>)> =
            std::collections::HashMap::new();
        while let Some(joined) = set.join_next().await {
            let Ok((id, name, subtitle, tracks)) = joined else {
                continue;
            };
            if !tracks.is_empty() {
                by_id.insert(id.to_string(), (name.to_string(), subtitle.to_string(), tracks));
            }
        }

        // Keep chart order stable; rotate cover so each refresh looks fresh.
        // Use u64 so 32-bit Android (armv7/i686) can compile the LCG constants.
        let seed = now_ms() as u64;
        let mut hot_playlists = Vec::new();
        let mut pool: Vec<Track> = Vec::new();
        let mut seen = std::collections::HashSet::new();

        for chart in CHARTS {
            let Some((name, subtitle, tracks)) = by_id.remove(chart.id) else {
                continue;
            };
            let cover_idx =
                (seed.wrapping_mul(31).wrapping_add(chart.id.len() as u64) as usize) % tracks.len();
            hot_playlists.push(RecommendPlaylist {
                id: chart.id.to_string(),
                name,
                subtitle,
                cover: tracks
                    .get(cover_idx)
                    .and_then(|t| t.cover.clone())
                    .or_else(|| tracks.first().and_then(|t| t.cover.clone())),
                track_count: tracks.len(),
                tracks: tracks.clone(),
            });
            for track in tracks {
                if seen.insert(track.uid.clone()) {
                    pool.push(track);
                }
            }
        }

        // Fisher–Yates with time seed → visibly different hot list every refresh.
        let mut hot_tracks = pool;
        let mut rng = seed ^ 0x9E37_79B9u64;
        for i in (1..hot_tracks.len()).rev() {
            rng = rng
                .wrapping_mul(6364136223846793005u64)
                .wrapping_add(1);
            let j = (rng as usize) % (i + 1);
            hot_tracks.swap(i, j);
        }
        hot_tracks.truncate(24);

        RecommendCatalog {
            hot_tracks,
            hot_playlists,
        }
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
