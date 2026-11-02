export type MusicSourceId = "netease" | "qq" | "kuwo" | "local";

export interface SourceSearchError {
  source: MusicSourceId;
  message: string;
}

export interface SearchPageResult {
  tracks: Track[];
  errors: SourceSearchError[];
}

export interface Track {
  uid: string;
  source: MusicSourceId;
  displayIndex: number;
  keyword: string;
  songId: string;
  songMid: string;
  qqId: string;
  qqSearchKey: string;
  qqIndex: number;
  title: string;
  artist: string;
  album: string;
  cover?: string | null;
  audioUrl?: string | null;
  lrc?: string | null;
  lrcUrl?: string | null;
  /** Translated LRC (bilingual lyrics). */
  lrcTranslation?: string | null;
  /** Word-level lyrics in NetEase YRC form; parsed into per-word timing. */
  lrcWords?: string | null;
  detailsLoaded: boolean;
  quality?: string | null;
  qualityLabel?: string | null;
  pay?: string | null;
}

export interface RecommendPlaylist {
  id: string;
  name: string;
  subtitle: string;
  cover?: string | null;
  trackCount: number;
  tracks: Track[];
}

export interface RecommendCatalog {
  hotTracks: Track[];
  hotPlaylists: RecommendPlaylist[];
}

export interface AppSettings {
  enabledSources: MusicSourceId[];
  limitPerSource: number;
  /** Absolute download directory; empty uses platform music/download default */
  downloadDir: string;
  /** Directory of `*.json` source manifests; empty uses app data sources/ */
  sourcesDir: string;
  /** Streaming quality preference: standard / hq / lossless */
  quality: string;
}

/** Preset download locations (used on Android where folder picker is unavailable). */
export interface DownloadDirPreset {
  id: string;
  label: string;
  path: string;
}

export interface StoredPlaylist {
  id: string;
  name: string;
  tracks: Array<{
    uid: string;
    source: string;
    title: string;
    artist: string;
    album: string;
    cover?: string | null;
    [key: string]: unknown;
  }>;
}

export interface LibrarySnapshot {
  version: number;
  savedAt: string;
  favorites: Array<{ uid: string; title: string; artist: string; cover?: string | null; source: string; [key: string]: unknown }>;
  playlists: StoredPlaylist[];
}

export interface SourceInfo {
  id: MusicSourceId;
  label: string;
}

/** Backend cache occupancy, mirrored by `get_cache_stats`. */
export interface CacheStats {
  searchEntries: number;
  detailsEntries: number;
  coverFiles: number;
  coverBytes: number;
}

export type TabId = "discover" | "library" | "settings";
export type PlayMode = "list" | "single" | "shuffle";

export interface LyricWord {
  time: number;
  /** End of this word — used to fill the karaoke highlight smoothly. */
  end: number;
  text: string;
}

export interface LyricLine {
  time: number;
  text: string;
  /** Translated line, shown under the original when available. */
  translation?: string;
  /** Word-level timing for karaoke highlighting; absent for plain LRC. */
  words?: LyricWord[];
}
