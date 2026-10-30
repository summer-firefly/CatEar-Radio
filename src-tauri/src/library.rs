use std::fs;
use std::path::PathBuf;

use chrono::Utc;
use parking_lot::Mutex;
use uuid::Uuid;

use crate::model::{LibrarySnapshot, StoredPlaylist, StoredTrack, Track};

pub struct LibraryStore {
    path: PathBuf,
    data: Mutex<LibrarySnapshot>,
}

impl LibraryStore {
    pub fn load(path: PathBuf) -> Self {
        let data = if path.exists() {
            fs::read_to_string(&path)
                .ok()
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default()
        } else {
            LibrarySnapshot::default()
        };
        Self {
            path,
            data: Mutex::new(data),
        }
    }

    fn persist(&self, data: &LibrarySnapshot) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut out = data.clone();
        out.saved_at = Utc::now().to_rfc3339();
        if let Ok(json) = serde_json::to_string_pretty(&out) {
            let _ = fs::write(&self.path, json);
        }
    }

    pub fn snapshot(&self) -> LibrarySnapshot {
        self.data.lock().clone()
    }

    pub fn favorites(&self) -> Vec<Track> {
        self.data
            .lock()
            .favorites
            .iter()
            .map(Track::from)
            .collect()
    }

    pub fn is_favorite(&self, uid: &str) -> bool {
        self.data.lock().favorites.iter().any(|t| t.uid == uid)
    }

    pub fn toggle_favorite(&self, track: &Track) -> bool {
        let mut data = self.data.lock();
        if let Some(pos) = data.favorites.iter().position(|t| t.uid == track.uid) {
            data.favorites.remove(pos);
            self.persist(&data);
            false
        } else {
            data.favorites.push(StoredTrack::from(track));
            self.persist(&data);
            true
        }
    }

    pub fn create_playlist(&self, name: &str) -> StoredPlaylist {
        let playlist = StoredPlaylist {
            id: Uuid::new_v4().to_string(),
            name: name.trim().to_string(),
            tracks: Vec::new(),
        };
        let mut data = self.data.lock();
        data.playlists.push(playlist.clone());
        self.persist(&data);
        playlist
    }

    pub fn delete_playlist(&self, id: &str) {
        let mut data = self.data.lock();
        data.playlists.retain(|p| p.id != id);
        self.persist(&data);
    }

    pub fn add_to_playlist(&self, playlist_id: &str, track: &Track) -> Result<(), String> {
        let mut data = self.data.lock();
        let playlist = data
            .playlists
            .iter_mut()
            .find(|p| p.id == playlist_id)
            .ok_or_else(|| "歌单不存在".to_string())?;
        if !playlist.tracks.iter().any(|t| t.uid == track.uid) {
            playlist.tracks.push(StoredTrack::from(track));
        }
        self.persist(&data);
        Ok(())
    }

    pub fn rename_playlist(&self, id: &str, name: &str) -> Result<(), String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("请输入歌单名称".into());
        }
        let mut data = self.data.lock();
        let playlist = data
            .playlists
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| "歌单不存在".to_string())?;
        playlist.name = trimmed.to_string();
        self.persist(&data);
        Ok(())
    }

    pub fn remove_from_playlist(&self, playlist_id: &str, track_uid: &str) -> Result<(), String> {
        let mut data = self.data.lock();
        let playlist = data
            .playlists
            .iter_mut()
            .find(|p| p.id == playlist_id)
            .ok_or_else(|| "歌单不存在".to_string())?;
        let before = playlist.tracks.len();
        playlist.tracks.retain(|t| t.uid != track_uid);
        if playlist.tracks.len() == before {
            return Err("歌单中没有这首歌".into());
        }
        self.persist(&data);
        Ok(())
    }

    pub fn move_playlist_track(
        &self,
        playlist_id: &str,
        from_index: usize,
        to_index: usize,
    ) -> Result<(), String> {
        let mut data = self.data.lock();
        let playlist = data
            .playlists
            .iter_mut()
            .find(|p| p.id == playlist_id)
            .ok_or_else(|| "歌单不存在".to_string())?;
        let len = playlist.tracks.len();
        if from_index >= len || to_index >= len {
            return Err("歌曲位置无效".into());
        }
        if from_index == to_index {
            return Ok(());
        }
        let track = playlist.tracks.remove(from_index);
        playlist.tracks.insert(to_index, track);
        self.persist(&data);
        Ok(())
    }

    pub fn export_json(&self) -> Result<String, String> {
        let data = self.data.lock().clone();
        serde_json::to_string_pretty(&data).map_err(|e| e.to_string())
    }

    pub fn import_json(&self, json: &str) -> Result<(), String> {
        let imported: LibrarySnapshot =
            serde_json::from_str(json).map_err(|e| format!("歌单 JSON 无效：{e}"))?;
        let mut data = self.data.lock();
        *data = imported;
        self.persist(&data);
        Ok(())
    }

    pub fn export_to_path(&self, path: &std::path::Path) -> Result<(), String> {
        let json = self.export_json()?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("无法创建目录：{e}"))?;
        }
        fs::write(path, json).map_err(|e| format!("写入失败：{e}"))
    }

    pub fn import_from_path(&self, path: &std::path::Path) -> Result<(), String> {
        let json = fs::read_to_string(path).map_err(|e| format!("读取失败：{e}"))?;
        self.import_json(&json)
    }
}
