use std::fs;
use std::io::Write;
use std::path::Path;

/// Write `bytes` to `path` atomically: temp file in the same directory, then rename.
/// A crash mid-write therefore leaves the previous file intact instead of JSON debris.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("data");
    let tmp = path.with_file_name(format!(".{file_name}.tmp"));
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        // Flush before rename so the bytes are actually on disk.
        file.sync_all()?;
    }
    match fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("maoer-storage-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn writes_new_file_and_creates_parent() {
        let dir = temp_dir("new");
        let path = dir.join("nested").join("settings.json");
        write_atomic(&path, b"{\"a\":1}").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"a\":1}");
        // No leftover temp file after a successful rename.
        assert!(!path.with_file_name(".settings.json.tmp").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn overwrite_replaces_previous_content() {
        let dir = temp_dir("overwrite");
        let path = dir.join("library.json");
        write_atomic(&path, b"old").unwrap();
        write_atomic(&path, b"new-and-longer").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new-and-longer");
        let _ = fs::remove_dir_all(&dir);
    }
}
