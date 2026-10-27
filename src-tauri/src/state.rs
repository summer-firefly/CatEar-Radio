use std::sync::Arc;

use crate::library::LibraryStore;
use crate::repo::{MusicRepository, RecommendRepository};
use crate::settings::SettingsStore;

pub struct AppState {
    pub music: Arc<MusicRepository>,
    pub recommend: Arc<RecommendRepository>,
    pub library: LibraryStore,
    pub settings: SettingsStore,
}
