use std::path::Path;

use lofty::config::WriteOptions;
use lofty::file::TaggedFileExt;
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::tag::{Accessor, ItemKey, Tag, TagExt, TagType};

use crate::model::Track;

/// Write ID3/Vorbis/MP4 metadata into a freshly downloaded file.
///
/// Best-effort by design: a format we cannot tag (or a broken header) must
/// never fail the download itself, so every error is returned to the caller
/// which only logs it.
pub fn write(
    path: &Path,
    track: &Track,
    cover: Option<(Vec<u8>, &'static str)>,
) -> Result<(), String> {
    let mut tagged = lofty::read_from_path(path).map_err(|e| e.to_string())?;

    let tag_type = tagged.primary_tag_type();
    if tagged.primary_tag().is_none() {
        // Most formats start without any tag block at all.
        tagged.insert_tag(Tag::new(tag_type));
    }
    let Some(tag) = tagged.primary_tag_mut() else {
        return Err("不支持写入该格式的标签".into());
    };

    let title = track.title.trim();
    if !title.is_empty() {
        tag.set_title(title.to_string());
    }
    let artist = track.artist.trim();
    if !artist.is_empty() {
        tag.set_artist(artist.to_string());
    }
    let album = track.album.trim();
    if !album.is_empty() {
        tag.set_album(album.to_string());
    }

    if let Some(lrc) = track.lrc.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        // ID3v2 has no `LYRICS` frame — synchronized lyrics live in `USLT`.
        let key = if tag_type == TagType::Id3v2 {
            ItemKey::UnsyncLyrics
        } else {
            ItemKey::Lyrics
        };
        tag.insert_text(key, lrc.to_string());
    }

    if let Some((bytes, ext)) = cover.filter(|(bytes, _)| !bytes.is_empty()) {
        // WebP is not part of the ID3v2 picture spec; skip it rather than
        // writing a frame some players refuse to parse.
        let mime = match ext {
            "jpg" | "jpeg" => Some(MimeType::Jpeg),
            "png" => Some(MimeType::Png),
            "gif" => Some(MimeType::Gif),
            _ => None,
        };
        if let Some(mime) = mime {
            tag.push_picture(
                Picture::unchecked(bytes)
                    .pic_type(PictureType::CoverFront)
                    .mime_type(mime)
                    .build(),
            );
        }
    }

    tag.save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{MusicSourceId, Track};

    /// One 128kbps MPEG-1 Layer III frame header plus its zeroed payload —
    /// enough for lofty to recognise the file as MP3.
    fn minimal_mp3() -> Vec<u8> {
        let mut bytes = vec![0xff, 0xfb, 0x90, 0x00];
        bytes.extend(std::iter::repeat_n(0u8, 413));
        bytes.extend_from_slice(&bytes.clone());
        bytes
    }

    fn track() -> Track {
        Track {
            uid: "test:1".into(),
            source: MusicSourceId::Netease,
            display_index: 1,
            keyword: String::new(),
            song_id: "1".into(),
            song_mid: String::new(),
            qq_id: String::new(),
            qq_search_key: String::new(),
            qq_index: 0,
            title: "夜曲".into(),
            artist: "周杰伦".into(),
            album: "十一月的萧邦".into(),
            cover: None,
            audio_url: None,
            lrc: Some("[00:01.00]一群嗜血的蚂蚁".into()),
            lrc_url: None,
            lrc_translation: None,
            lrc_words: None,
            details_loaded: true,
            quality: None,
            quality_label: None,
            pay: None,
        }
    }

    #[test]
    fn writes_text_and_cover_into_the_file() {
        let dir = std::env::temp_dir().join(format!("maoer-tags-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("track.mp3");
        std::fs::write(&path, minimal_mp3()).unwrap();

        // 1x1 PNG — smallest thing lofty will accept as a front cover.
        let png = vec![
            0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, b'I', b'H',
            b'D', b'R', 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1f, 0x15, 0xc4, 0x89,
        ];
        write(&path, &track(), Some((png, "png"))).unwrap();

        let tagged = lofty::read_from_path(&path).unwrap();
        let tag = tagged.primary_tag().expect("tag was written");
        assert_eq!(tag.title().as_deref(), Some("夜曲"));
        assert_eq!(tag.artist().as_deref(), Some("周杰伦"));
        assert_eq!(tag.album().as_deref(), Some("十一月的萧邦"));
        assert_eq!(tag.pictures().len(), 1);
        let lyrics = tag.get_string(ItemKey::UnsyncLyrics);
        assert!(lyrics.is_some_and(|text| text.contains("一群嗜血的蚂蚁")));

        std::fs::remove_dir_all(&dir).ok();
    }
}
