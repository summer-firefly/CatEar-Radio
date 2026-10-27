use std::fs;
use std::path::PathBuf;

use parking_lot::Mutex;

use crate::model::AppSettings;

pub struct SettingsStore {
    path: PathBuf,
    settings: Mutex<AppSettings>,
}

impl SettingsStore {
    pub fn load(path: PathBuf) -> Self {
        let settings = if path.exists() {
            fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            AppSettings::default()
        };
        Self {
            path,
            settings: Mutex::new(settings),
        }
    }

    pub fn get(&self) -> AppSettings {
        self.settings.lock().clone()
    }

    pub fn save(&self, settings: AppSettings) -> AppSettings {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string_pretty(&settings) {
            let _ = fs::write(&self.path, json);
        }
        *self.settings.lock() = settings.clone();
        settings
    }
}
