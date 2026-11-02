import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, emitTo } from "@tauri-apps/api/event";
import "./assets/fonts/fonts.css";
import "./styles.css";
import logoUrl from "./assets/logo.png";
import { formatTime, parseLrc } from "./lrc";
import {
  attach,
  canProcess,
  EQ_BANDS,
  EQ_GAIN_RANGE,
  EQ_PRESETS,
  isAttached,
  setGains,
  setPreamp,
} from "./equalizer";
import { matchesAnyField } from "./pinyin";
import {
  initOsMediaControls,
  syncOsMediaPlaybackRate,
  syncOsMediaPlaybackState,
  syncOsMediaPosition,
  syncOsMediaSkipAvailability,
  syncOsMediaTrack,
} from "./os-media";
import type {
  AppSettings,
  CacheStats,
  DownloadDirPreset,
  LibrarySnapshot,
  LyricLine,
  PlayMode,
  RecommendCatalog,
  RecommendPlaylist,
  SearchPageResult,
  SourceInfo,
  SourceSearchError,
  StoredPlaylist,
  TabId,
  Track,
  UpdateInfo,
} from "./types";

function isAndroid(): boolean {
  return (
    document.documentElement.classList.contains("is-android") ||
    /android/i.test(navigator.userAgent || "")
  );
}

/** Remote URLs pass through; absolute local paths go through asset protocol. */
function toPlayableSrc(url: string): string {
  if (
    /^https?:\/\//i.test(url) ||
    url.startsWith("blob:") ||
    url.startsWith("asset:") ||
    url.startsWith("http://asset.localhost") ||
    url.startsWith("https://asset.localhost")
  ) {
    return url;
  }
  return convertFileSrc(url);
}

const SOURCE_LABEL: Record<string, string> = {
  netease: "网易云",
  qq: "QQ",
  kuwo: "酷我",
  local: "本地",
};

const QUALITY_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "standard", label: "标准 (128k)" },
  { id: "hq", label: "高品质 (320k)" },
  { id: "lossless", label: "无损 (FLAC)" },
];

const VOLUME_KEY = "maoer-volume";
const RECENT_KEY = "maoer-recent";
const RECENT_MAX = 50;
const LYRIC_FONT_KEY = "maoer-lyric-font";
const LYRIC_TRANSLATION_KEY = "maoer-lyric-translation";
const LYRIC_OFFSET_KEY = "maoer-lyric-offset";
const LYRIC_OFFSET_MAP_KEY = "maoer-lyric-offset-map";
type LyricFontSize = "sm" | "md" | "lg";

/** Bilingual subtitles default on — the line is only rendered when one exists. */
function loadLyricTranslation(): boolean {
  try {
    return localStorage.getItem(LYRIC_TRANSLATION_KEY) !== "0";
  } catch {
    return true;
  }
}

function loadLyricFont(): LyricFontSize {
  try {
    const v = localStorage.getItem(LYRIC_FONT_KEY);
    if (v === "sm" || v === "md" || v === "lg") return v;
  } catch {
    /* ignore */
  }
  return "md";
}

function loadLyricOffset(): number {
  try {
    const v = Number(localStorage.getItem(LYRIC_OFFSET_KEY));
    if (Number.isFinite(v)) return clampLyricOffset(v);
  } catch {
    /* ignore */
  }
  return 0;
}

function clampLyricOffset(v: number): number {
  return Math.max(-10, Math.min(10, Math.round(v * 2) / 2));
}

/** Per-track lyric offsets; falls back to the global default when absent. */
function loadLyricOffsetMap(): Record<string, number> {
  try {
    const raw = localStorage.getItem(LYRIC_OFFSET_MAP_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (!parsed || typeof parsed !== "object") return {};
    const out: Record<string, number> = {};
    for (const [uid, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) out[uid] = clampLyricOffset(v);
    }
    return out;
  } catch {
    return {};
  }
}

function lyricOffsetFor(uid: string | undefined): number {
  if (uid && uid in state.lyricOffsetMap) return state.lyricOffsetMap[uid];
  return state.lyricOffsetDefault;
}

function loadVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    if (!Number.isFinite(v)) return 0.85;
    return Math.min(1, Math.max(0, v));
  } catch {
    return 0.85;
  }
}

function persistVolume(v: number) {
  try {
    localStorage.setItem(VOLUME_KEY, String(v));
  } catch {
    /* ignore quota */
  }
}

function loadRecent(): Track[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof (x as { uid?: unknown }).uid === "string")
      .map((x) => storedToTrack(x as LibrarySnapshot["favorites"][number]))
      .slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}

/** Trim a track down to the fields needed to restore playback later. */
function compactTrack(t: Track): Track {
  return {
    uid: t.uid,
    source: t.source,
    displayIndex: t.displayIndex,
    keyword: t.keyword,
    songId: t.songId,
    songMid: t.songMid,
    qqId: t.qqId,
    qqSearchKey: t.qqSearchKey,
    qqIndex: t.qqIndex,
    title: t.title,
    artist: t.artist,
    album: t.album,
    cover: t.cover ?? null,
    detailsLoaded: false,
  };
}

function persistRecent(tracks: Track[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(tracks.slice(0, RECENT_MAX).map(compactTrack)));
  } catch {
    /* ignore quota */
  }
}

function pushRecent(track: Track) {
  const next = [track, ...state.recent.filter((t) => t.uid !== track.uid)].slice(0, RECENT_MAX);
  state.recent = next;
  persistRecent(next);
}

const SESSION_KEY = "maoer-session";
const SESSION_QUEUE_MAX = 300;

interface StoredSession {
  queue: Track[];
  queueIndex: number;
  queueKind: null | "search";
  playMode: PlayMode;
  position: number;
  duration: number;
}

function loadSession(): StoredSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession> | null;
    if (!parsed || !Array.isArray(parsed.queue) || !parsed.queue.length) return null;
    const queue = parsed.queue
      .filter((x): x is Track => !!x && typeof x === "object" && typeof (x as Track).uid === "string")
      .map((x) => compactTrack(x))
      .slice(0, SESSION_QUEUE_MAX);
    if (!queue.length) return null;
    const index = Math.min(Math.max(0, Number(parsed.queueIndex) || 0), queue.length - 1);
    const mode = parsed.playMode === "single" || parsed.playMode === "shuffle" ? parsed.playMode : "list";
    return {
      queue,
      queueIndex: index,
      queueKind: parsed.queueKind === "search" ? "search" : null,
      playMode: mode,
      position: Math.max(0, Number(parsed.position) || 0),
      duration: Math.max(0, Number(parsed.duration) || 0),
    };
  } catch {
    return null;
  }
}

let sessionWriteTimer = 0;

function persistSession() {
  // Throttle instead of debounce — timeupdate fires continuously while playing.
  if (sessionWriteTimer) return;
  sessionWriteTimer = window.setTimeout(writeSessionNow, 2000);
}

function writeSessionNow() {
  if (sessionWriteTimer) {
    window.clearTimeout(sessionWriteTimer);
    sessionWriteTimer = 0;
  }
  const current = state.current;
  if (!current || !state.queue.length) {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    const payload: StoredSession = {
      queue: state.queue.slice(0, SESSION_QUEUE_MAX).map(compactTrack),
      queueIndex: Math.max(0, state.queueIndex),
      queueKind: state.queueKind,
      playMode: state.playMode,
      position: state.position,
      duration: state.duration || audio.duration || 0,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
  } catch {
    /* ignore quota */
  }
}

const state = {
  tab: "discover" as TabId,
  keyword: "",
  searching: false,
  searchTracks: [] as Track[],
  /** Tracks accumulated across search pages for continuous playback. */
  searchAccum: [] as Track[],
  searchErrors: [] as SourceSearchError[],
  searchLoadedMaxPage: 0,
  /** Whether the active play queue comes from search results. */
  queueKind: null as null | "search",
  /** Search result groups expanded to show the same song on other sources. */
  searchGroupOpen: new Set<string>(),
  recommend: null as RecommendCatalog | null,
  recommendLoading: false,
  settings: {
    enabledSources: [],
    limitPerSource: 10,
    downloadDir: "",
    sourcesDir: "",
    quality: "hq",
  } as AppSettings,
  defaultDownloadDir: "",
  defaultSourcesDir: "",
  downloadingUid: "" as string,
  /** Queue of tracks waiting for the single download slot. */
  downloadQueue: [] as Track[],
  /** Live byte progress of in-flight downloads, keyed by track uid. */
  downloadProgress: {} as Record<string, { downloaded: number; total: number }>,
  /** Last cache occupancy reported by the backend. */
  cacheStats: null as null | CacheStats,
  /** Latest version check result; null until the user asks. */
  updateInfo: null as null | UpdateInfo,
  checkingUpdate: false,
  sources: [] as SourceInfo[],
  library: null as LibrarySnapshot | null,
  libraryPane: "favorites" as "favorites" | "recent" | "playlists" | "local",
  recent: loadRecent(),
  /** Local audio files found by the last folder scan. */
  localTracks: [] as Track[],
  localScanDir: "",
  localScanning: false,
  queue: [] as Track[],
  queueIndex: -1,
  current: null as Track | null,
  playing: false,
  preparing: false,
  position: 0,
  duration: 0,
  volume: loadVolume(),
  muted: false,
  volumeBeforeMute: loadVolume(),
  /** Playback speed — persisted, applied to both audio elements. */
  playRate: loadPlayRate(),
  /** WebAudio equalizer — off by default so plain playback is never rerouted. */
  eq: {
    enabled: loadEqEnabled(),
    preset: loadEqPreset(),
    gains: loadEqGains(),
    preamp: loadEqPreamp(),
  },
  playMode: "list" as PlayMode,
  lyrics: [] as LyricLine[],
  lyricsOpen: false,
  lyricFont: loadLyricFont() as LyricFontSize,
  /** Show the translated line under the original when one exists. */
  lyricTranslation: loadLyricTranslation(),
  /** Fallback offset used when the current track has no per-track override. */
  lyricOffsetDefault: loadLyricOffset(),
  /** Per-track lyric offsets keyed by track uid. */
  lyricOffsetMap: loadLyricOffsetMap(),
  toast: "",
  /** Light/dark appearance — persisted, applied on <html data-theme>. */
  theme: loadTheme(),
  /** Frameless always-on-top lyrics overlay (desktop only). */
  desktopLyrics: {
    visible: loadDesktopLyricsVisible(),
    locked: false,
  },
  page: 1,
  /** Whether a newer search page likely exists (based on last page size). */
  searchHasMore: false,
  searchHistoryOpen: false,
  /** Client-side pages for local lists (hot / favorites / recommend playlist browse). */
  hotPage: 1,
  favPage: 1,
  recentPage: 1,
  browsePlaylistId: null as string | null,
  browsePage: 1,
  /** Artist / album drill-down opened from a track row. */
  detail: null as null | {
    kind: "artist" | "album";
    name: string;
    /** Seed artist — needed as part of the album search keyword. */
    artist: string;
    tracks: Track[];
    loading: boolean;
    /** Set when the source returned no album field and we fell back to a keyword search. */
    note: string;
    error: string;
    page: number;
  },
  /** Sleep timer: timed countdown or stop after current track. */
  sleep: null as null | { mode: "timed"; endsAt: number; minutes: number } | { mode: "track" },
  /** One-shot enter animation after a full recommend reload. */
  recommendReveal: false,
  /** In-app dialog — WKWebView has no window.prompt/confirm. */
  dialog: null as
    | null
    | { kind: "new-playlist" }
    | { kind: "import-playlist"; url: string; busy?: boolean }
    | { kind: "rename-playlist"; id: string; name: string }
    | { kind: "delete-playlist"; id: string; name: string }
    | { kind: "add-to-playlist"; trackUid: string }
    | { kind: "import-library"; path: string }
    | { kind: "sleep-timer" }
    | { kind: "pick-download-dir"; options: DownloadDirPreset[] },
  downloadDirPresets: [] as DownloadDirPreset[],
  /** Custom track context menu (native WebView menu only has Reload). */
  contextMenu: null as null | { x: number; y: number; trackUid: string; queueKey: string },
  /** Play queue drawer (bottom-right sheet). */
  queueOpen: false,
};

/** Suppress duplicate recommend-updated paints right after a user refresh. */
let ignoreRecommendEventsUntil = 0;

const SEARCH_HISTORY_KEY = "maoer-search-history";
const SEARCH_HISTORY_MAX = 12;

const THEME_KEY = "maoer-theme";
type Theme = "dark" | "light";

function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return "dark";
}

/** Tokens live in `html[data-theme]`, so flipping the attribute retints everything. */
function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

function setTheme(theme: Theme, opts?: { silent?: boolean }) {
  state.theme = theme;
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* ignore */
  }
  patchThemeToggle();
  if (state.desktopLyrics.visible) pushDesktopLyricsState({ immediate: true });
  if (!opts?.silent) toast(theme === "light" ? "已切换浅色主题" : "已切换深色主题");
}

function toggleTheme() {
  setTheme(state.theme === "light" ? "dark" : "light");
}

/* —— Desktop lyrics overlay (frameless always-on-top window) —— */

const DESKTOP_LYRICS_KEY = "maoer-desktop-lyrics";

interface DesktopLyricsStatus {
  visible: boolean;
  locked: boolean;
}

/** Payload pushed to the overlay window; `lyrics` is null unless the track changed. */
interface DesktopLyricsPayload {
  uid: string;
  title: string;
  artist: string;
  lyrics: LyricLine[] | null;
  position: number;
  playing: boolean;
  theme: Theme;
  offset: number;
}

function loadDesktopLyricsVisible(): boolean {
  try {
    return localStorage.getItem(DESKTOP_LYRICS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Track whose lyrics the overlay already holds — only resend on change. */
let desktopLyricsSentUid = "";
let desktopLyricsTimer = 0;

function buildDesktopLyricsPayload(full: boolean): DesktopLyricsPayload {
  const track = state.current;
  return {
    uid: track?.uid ?? "",
    title: track?.title ?? "",
    artist: track?.artist ?? "",
    // The overlay has its own line layout, so word timings are dropped.
    lyrics: full ? overlayLyrics() : null,
    position: state.position,
    playing: state.playing,
    theme: state.theme,
    offset: lyricOffsetFor(track?.uid),
  };
}

/** Overlay view of the lyrics — honours the translation toggle. */
function overlayLyrics(): LyricLine[] {
  return state.lyrics.map((line) => ({
    time: line.time,
    text: line.text,
    translation: state.lyricTranslation ? line.translation : undefined,
  }));
}

/** Keep the overlay in sync — throttled, and skipped entirely while it is hidden. */
function pushDesktopLyricsState(opts?: { immediate?: boolean; full?: boolean }) {
  if (!state.desktopLyrics.visible || isAndroid()) return;
  const send = () => {
    desktopLyricsTimer = 0;
    const uid = state.current?.uid ?? "";
    const full = opts?.full === true || uid !== desktopLyricsSentUid;
    desktopLyricsSentUid = uid;
    void emitTo("desktop-lyrics", "desktop-lyrics-state", buildDesktopLyricsPayload(full)).catch(
      () => undefined,
    );
  };
  if (opts?.immediate) {
    if (desktopLyricsTimer) window.clearTimeout(desktopLyricsTimer);
    send();
    return;
  }
  if (desktopLyricsTimer) return;
  desktopLyricsTimer = window.setTimeout(send, 250);
}

function applyDesktopLyricsStatus(status: DesktopLyricsStatus) {
  state.desktopLyrics.visible = status.visible;
  state.desktopLyrics.locked = status.locked;
  try {
    localStorage.setItem(DESKTOP_LYRICS_KEY, status.visible ? "1" : "0");
  } catch {
    /* ignore */
  }
  // The settings card swaps the unlock button / hint, so it needs a full repaint.
  if (state.tab === "settings") renderMain();
  else patchDesktopLyricsToggle();
}

function patchDesktopLyricsToggle() {
  const btn = document.querySelector("#btn-desktop-lyrics");
  if (!btn) return;
  btn.textContent = state.desktopLyrics.visible ? "已开启" : "关闭";
  btn.setAttribute("aria-pressed", String(state.desktopLyrics.visible));
}

async function setDesktopLyrics(visible: boolean, opts?: { silent?: boolean }) {
  if (isAndroid()) return;
  try {
    // Showing always unlocks: a click-through window that reappears is confusing.
    const status = await invoke<DesktopLyricsStatus>("set_desktop_lyrics", {
      visible,
      locked: visible ? false : null,
    });
    desktopLyricsSentUid = "";
    applyDesktopLyricsStatus(status);
    if (!opts?.silent) toast(visible ? "桌面歌词已开启" : "桌面歌词已关闭");
    if (visible) pushDesktopLyricsState({ immediate: true, full: true });
  } catch (e) {
    if (!opts?.silent) toast(`桌面歌词不可用：${String(e)}`);
  }
}

function toggleDesktopLyrics() {
  void setDesktopLyrics(!state.desktopLyrics.visible);
}

/** Click-through unlock; the overlay itself is unreachable while locked. */
async function unlockDesktopLyrics() {
  try {
    const status = await invoke<DesktopLyricsStatus>("set_desktop_lyrics", { locked: false });
    applyDesktopLyricsStatus(status);
    toast("桌面歌词已解锁");
  } catch (e) {
    toast(`解锁失败：${String(e)}`);
  }
}

/** Click-through mode — the overlay can no longer receive clicks after this. */
async function lockDesktopLyrics() {
  try {
    const status = await invoke<DesktopLyricsStatus>("set_desktop_lyrics", { locked: true });
    applyDesktopLyricsStatus(status);
    toast("桌面歌词已锁定，可从托盘或设置解锁");
  } catch (e) {
    toast(`锁定失败：${String(e)}`);
  }
}

/** Overlay button events plus its "I just booted, send me state" handshake. */
async function listenDesktopLyrics() {
  try {
    // Tray toggles happen in Rust — mirror whatever it decided.
    await listen<DesktopLyricsStatus>("desktop-lyrics-status", (event) => {
      const wasVisible = state.desktopLyrics.visible;
      desktopLyricsSentUid = "";
      applyDesktopLyricsStatus(event.payload);
      if (event.payload.visible || wasVisible) {
        pushDesktopLyricsState({ immediate: true, full: true });
      }
    });
    await listen("desktop-lyrics-ready", () => {
      // The hidden overlay window loads at startup too — only answer while shown.
      if (!state.desktopLyrics.visible) return;
      desktopLyricsSentUid = "";
      pushDesktopLyricsState({ immediate: true, full: true });
    });
    await listen<"lock" | "close">("desktop-lyrics-action", (event) => {
      if (event.payload === "close") {
        void setDesktopLyrics(false);
        return;
      }
      void lockDesktopLyrics();
    });
  } catch (e) {
    console.error(e);
  }
}

/** Repaint only the toggle so switching does not rebuild the settings page. */
function patchThemeToggle() {
  const btn = document.querySelector("#btn-theme-toggle");
  if (btn) {
    btn.textContent = state.theme === "light" ? "浅色" : "深色";
    btn.setAttribute("aria-pressed", String(state.theme === "light"));
  }
  const quick = document.querySelector("#btn-theme-quick");
  if (quick) quick.textContent = state.theme === "light" ? "☾" : "☀";
}

function loadSearchHistory(): string[] {
  try {
    const raw = localStorage.getItem(SEARCH_HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  } catch {
    return [];
  }
}

function pushSearchHistory(keyword: string) {
  const k = keyword.trim();
  if (!k) return;
  const next = [k, ...loadSearchHistory().filter((x) => x !== k)].slice(0, SEARCH_HISTORY_MAX);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
}

function removeSearchHistory(keyword: string) {
  const next = loadSearchHistory().filter((x) => x !== keyword);
  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
}

function clearSearchHistory() {
  localStorage.removeItem(SEARCH_HISTORY_KEY);
}

/** Shown before the recommendation catalog has loaded. */
const HOT_FALLBACK = ["周杰伦", "林俊杰", "晴天", "夜曲", "陈奕迅", "五月天", "稻香", "孤勇者"];
const SUGGEST_MAX = 6;

/**
 * Hot keywords straight from the recommendation catalog, so they follow
 * whatever the sources currently promote. Artists come first because that is
 * what people type most; titles and a static fallback fill the rest.
 */
function hotKeywords(): string[] {
  const hot = state.recommend?.hotTracks ?? [];
  const words: string[] = [];
  const push = (word: string) => {
    const value = word.trim();
    if (value && !words.includes(value)) words.push(value);
  };
  for (const track of hot) {
    for (const artist of track.artist.split(/[/,、&;，]/)) push(artist);
    if (words.length >= 8) break;
  }
  for (const track of hot) {
    push(track.title);
    if (words.length >= 10) break;
  }
  for (const word of HOT_FALLBACK) {
    if (words.length >= 10) break;
    push(word);
  }
  return words.slice(0, 10);
}

/** Zero-network matches from what the app already holds — instant suggestions. */
function localSuggestions(query: string): Track[] {
  const q = query.trim();
  if (!q) return [];
  const pools = [
    state.localTracks,
    (state.library?.favorites ?? []).map(storedToTrack),
    state.recent,
    state.recommend?.hotTracks ?? [],
    state.searchAccum,
  ];
  const seen = new Set<string>();
  const hits: Track[] = [];
  for (const pool of pools) {
    for (const track of pool) {
      if (hits.length >= SUGGEST_MAX) return hits;
      if (seen.has(track.uid)) continue;
      // Pinyin aware: "xxy" and "xiaoxingyun" both find 小幸运.
      if (!matchesAnyField([track.title, track.artist, track.album], q)) continue;
      seen.add(track.uid);
      hits.push(track);
    }
  }
  return hits;
}

function searchSuggestHtml(): string {
  const query = state.keyword.trim();
  if (query) {
    const hits = localSuggestions(query);
    return `<div class="search-history" id="search-history">
      <div class="search-history-head"><span>本地结果</span></div>
      ${
        hits.length
          ? hits
              .map(
                (track) => `
        <button type="button" class="search-history-item" data-suggest-uid="${escapeAttr(track.uid)}">
          <span class="search-history-text">${escapeHtml(track.title || "未知歌曲")}<span class="suggest-sub">${escapeHtml(track.artist)}</span></span>
        </button>`,
              )
              .join("")
          : `<div class="search-empty">没有本地匹配，按回车在全部音源搜索</div>`
      }
    </div>`;
  }
  const history = loadSearchHistory();
  const hot = hotKeywords();
  return `<div class="search-history" id="search-history">
    ${
      history.length
        ? `<div class="search-history-head">
            <span>搜索历史</span>
            <button type="button" class="search-history-clear" id="btn-clear-history">清空</button>
          </div>
          ${history
            .map(
              (item) => `
          <button type="button" class="search-history-item" data-history="${escapeAttr(item)}">
            <span class="search-history-text">${escapeHtml(item)}</span>
            <span class="search-history-del" data-history-del="${escapeAttr(item)}" title="删除">×</span>
          </button>`,
            )
            .join("")}`
        : ""
    }
    ${
      hot.length
        ? `<div class="search-history-head"><span>热门搜索</span></div>
          <div class="search-hot">
            ${hot
              .map(
                (word) =>
                  `<button type="button" class="search-hot-item" data-hot-word="${escapeAttr(word)}">${escapeHtml(word)}</button>`,
              )
              .join("")}
          </div>`
        : ""
    }
  </div>`;
}

/** Repaint the dropdown only — re-rendering the page would steal input focus. */
function patchSearchSuggest() {
  const host = document.querySelector("#search-suggest");
  if (!host) return;
  host.innerHTML = state.searchHistoryOpen ? searchSuggestHtml() : "";
  if (state.searchHistoryOpen) bindSearchSuggestEvents();
}

/** Wire the freshly rendered dropdown; it is replaced on every keystroke. */
function bindSearchSuggestEvents() {
  document.querySelector("#btn-clear-history")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearSearchHistory();
    patchSearchSuggest();
  });
  document.querySelectorAll<HTMLElement>("[data-history]").forEach((el) => {
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      const del = (e.target as HTMLElement).closest("[data-history-del]") as HTMLElement | null;
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        removeSearchHistory(del.dataset.historyDel || "");
        patchSearchSuggest();
        return;
      }
      state.keyword = el.dataset.history || "";
      void doSearch(true);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-hot-word]").forEach((el) => {
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => {
      state.keyword = el.dataset.hotWord || "";
      void doSearch(true);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-suggest-uid]").forEach((el) => {
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", () => {
      const uid = el.dataset.suggestUid || "";
      const hits = localSuggestions(state.keyword);
      const track = hits.find((t) => t.uid === uid);
      if (!track) return;
      state.searchHistoryOpen = false;
      detachSearchHistoryDocHandler();
      patchSearchSuggest();
      void playTrack(track, hits);
    });
  });
}

let playGeneration = 0;
/** Saved position for a restored track — applied only when that exact track is loaded. */
let pendingResume: { uid: string; seconds: number } | null = null;
let lastMotionTab: TabId | "" = "";
let lastMotionTrackUid = "";
let lastMotionLyricsOpen: boolean | null = null;
let searchHistoryDocHandler: ((e: PointerEvent) => void) | null = null;

function detachSearchHistoryDocHandler() {
  if (!searchHistoryDocHandler) return;
  document.removeEventListener("pointerdown", searchHistoryDocHandler, true);
  searchHistoryDocHandler = null;
}

function attachSearchHistoryDocHandler() {
  detachSearchHistoryDocHandler();
  searchHistoryDocHandler = (e: PointerEvent) => {
    const t = e.target as Element | null;
    if (t?.closest?.(".search-field")) return;
    state.searchHistoryOpen = false;
    detachSearchHistoryDocHandler();
    patchSearchSuggest();
  };
  // Defer so the focusing click doesn't close the panel immediately.
  window.setTimeout(() => {
    if (searchHistoryDocHandler) {
      document.addEventListener("pointerdown", searchHistoryDocHandler, true);
    }
  }, 0);
}

const audio = new Audio();
audio.preload = "metadata";
audio.volume = state.volume;
// Do not set crossOrigin: many music CDNs omit CORS headers, which makes
// HTMLMediaElement.play() reject with NotSupportedError in WKWebView.

/** Outgoing track during a crossfade; idle (no src) the rest of the time. */
const crossfadeAudio = new Audio();
crossfadeAudio.preload = "auto";

const PLAY_RATE_KEY = "maoer-play-rate";
const PLAY_RATES = [0.75, 1, 1.25, 1.5, 2];

function loadPlayRate(): number {
  try {
    const v = Number(localStorage.getItem(PLAY_RATE_KEY));
    if (PLAY_RATES.includes(v)) return v;
  } catch {
    /* ignore */
  }
  return 1;
}

function playRateLabel(rate: number): string {
  return `${rate}×`;
}

function setPlayRate(rate: number, opts?: { silent?: boolean }) {
  state.playRate = PLAY_RATES.includes(rate) ? rate : 1;
  audio.playbackRate = state.playRate;
  crossfadeAudio.playbackRate = state.playRate;
  syncOsMediaPlaybackRate(state.playRate, state.position, state.duration);
  try {
    localStorage.setItem(PLAY_RATE_KEY, String(state.playRate));
  } catch {
    /* ignore */
  }
  patchPlayerDock();
  if (!opts?.silent) toast(`播放速度 ${playRateLabel(state.playRate)}`);
}

function cyclePlayRate() {
  const idx = PLAY_RATES.indexOf(state.playRate);
  setPlayRate(PLAY_RATES[(idx + 1) % PLAY_RATES.length]);
}

const EQ_ENABLED_KEY = "maoer-eq-enabled";
const EQ_PRESET_KEY = "maoer-eq-preset";
const EQ_GAINS_KEY = "maoer-eq-gains";
const EQ_PREAMP_KEY = "maoer-eq-preamp";

function loadEqEnabled(): boolean {
  try {
    return localStorage.getItem(EQ_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

function loadEqPreset(): string {
  try {
    const v = localStorage.getItem(EQ_PRESET_KEY);
    if (v && EQ_PRESETS.some((p) => p.id === v)) return v;
  } catch {
    /* ignore */
  }
  return "flat";
}

function loadEqGains(): number[] {
  const preset = EQ_PRESETS.find((p) => p.id === loadEqPreset());
  const fallback = preset ? preset.gains : EQ_PRESETS[0].gains;
  try {
    const raw = localStorage.getItem(EQ_GAINS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    if (Array.isArray(parsed) && parsed.length === EQ_BANDS.length) {
      return parsed.map((v, i) =>
        typeof v === "number" && Number.isFinite(v)
          ? Math.max(-EQ_GAIN_RANGE, Math.min(EQ_GAIN_RANGE, v))
          : fallback[i],
      );
    }
  } catch {
    /* ignore */
  }
  return [...fallback];
}

function loadEqPreamp(): number {
  try {
    const v = Number(localStorage.getItem(EQ_PREAMP_KEY));
    if (Number.isFinite(v)) return Math.max(-EQ_GAIN_RANGE, Math.min(EQ_GAIN_RANGE, v));
  } catch {
    /* ignore */
  }
  return 0;
}

function persistEq() {
  try {
    localStorage.setItem(EQ_ENABLED_KEY, state.eq.enabled ? "1" : "0");
    localStorage.setItem(EQ_PRESET_KEY, state.eq.preset);
    localStorage.setItem(EQ_GAINS_KEY, JSON.stringify(state.eq.gains));
    localStorage.setItem(EQ_PREAMP_KEY, String(state.eq.preamp));
  } catch {
    /* ignore quota */
  }
}

/** Apply the current gains to the graph; a no-op while it is not built. */
function syncEqToGraph() {
  setGains(state.eq.gains);
  setPreamp(state.eq.preamp);
}

/**
 * Turn the equalizer on/off.
 *
 * Enabling probes the current stream first: a cross-origin response without
 * CORS becomes silent once routed through WebAudio, and that is irreversible.
 */
async function toggleEq(force?: boolean) {
  const next = force ?? !state.eq.enabled;
  if (next === state.eq.enabled) return;
  if (!next) {
    state.eq.enabled = false;
    persistEq();
    toast("均衡器已关闭，重启后生效");
    renderMain();
    return;
  }
  const src = audio.getAttribute("src");
  if (src) {
    const ok = await canProcess(src);
    if (!ok) {
      toast("该音频源不允许音频处理，均衡器无法开启");
      return;
    }
  }
  const error = attach(audio);
  if (error) {
    toast(error);
    return;
  }
  state.eq.enabled = true;
  syncEqToGraph();
  persistEq();
  toast("均衡器已开启");
  renderMain();
}

/**
 * Rebuild the graph on the first play after a restart — a fresh element loses
 * the routing, so an enabled EQ would otherwise silently do nothing.
 */
async function maybeAttachEq() {
  if (!state.eq.enabled || isAttached()) return;
  const src = audio.getAttribute("src");
  if (!src) return;
  if (!(await canProcess(src))) {
    state.eq.enabled = false;
    persistEq();
    toast("该音频源不允许音频处理，均衡器已自动关闭");
    return;
  }
  const error = attach(audio);
  if (error) {
    state.eq.enabled = false;
    persistEq();
    toast(error);
    return;
  }
  syncEqToGraph();
}

function applyEqPreset(id: string) {
  const preset = EQ_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  state.eq.preset = id;
  state.eq.gains = [...preset.gains];
  syncEqToGraph();
  persistEq();
  paintEqPanel();
}

function setEqBand(index: number, gain: number) {
  state.eq.gains[index] = Math.max(-EQ_GAIN_RANGE, Math.min(EQ_GAIN_RANGE, gain));
  // Touching a band means the sound is now custom.
  state.eq.preset = "custom";
  syncEqToGraph();
  persistEq();
  paintEqPanel();
}

function setEqPreampValue(db: number) {
  state.eq.preamp = Math.max(-EQ_GAIN_RANGE, Math.min(EQ_GAIN_RANGE, db));
  syncEqToGraph();
  persistEq();
  paintEqPanel();
}

/** Sliders are live; repaint the labels without rebuilding the settings page. */
function paintEqPanel() {
  EQ_BANDS.forEach((_, i) => {
    const value = document.querySelector(`#eq-band-value-${i}`);
    if (value) value.textContent = eqGainLabel(state.eq.gains[i]);
    const slider = document.querySelector<HTMLInputElement>(`#eq-band-${i}`);
    if (slider && document.activeElement !== slider) slider.value = String(state.eq.gains[i]);
  });
  const preampValue = document.querySelector("#eq-preamp-value");
  if (preampValue) preampValue.textContent = eqGainLabel(state.eq.preamp);
  document.querySelectorAll<HTMLElement>("[data-eq-preset]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.eqPreset === state.eq.preset);
  });
}

function eqGainLabel(db: number): string {
  return `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;
}

function eqPanelHtml(): string {
  return `
    <div class="settings-card">
      <div class="eq-head">
        <h3>均衡器</h3>
        <button class="btn ghost sm" id="btn-eq-toggle" type="button" aria-pressed="${state.eq.enabled}">${
          state.eq.enabled ? "已开启" : "关闭"
        }</button>
      </div>
      <div class="eq-presets">
        ${EQ_PRESETS.map(
          (p) =>
            `<button type="button" class="eq-preset${
              state.eq.preset === p.id ? " active" : ""
            }" data-eq-preset="${p.id}">${p.label}</button>`,
        ).join("")}
      </div>
      <div class="eq-bands">
        ${EQ_BANDS.map((freq, i) => {
          const gain = state.eq.gains[i] ?? 0;
          return `
          <label class="eq-band">
            <span class="eq-band-freq">${freq >= 1000 ? `${freq / 1000}k` : freq}</span>
            <input type="range" id="eq-band-${i}" data-eq-band="${i}" min="-${EQ_GAIN_RANGE}" max="${EQ_GAIN_RANGE}" step="0.5" value="${gain}" aria-label="${freq} Hz" />
            <span class="eq-band-value" id="eq-band-value-${i}">${eqGainLabel(gain)}</span>
          </label>`;
        }).join("")}
      </div>
      <div class="eq-preamp">
        <span class="hint">前级</span>
        <input type="range" id="eq-preamp" min="-${EQ_GAIN_RANGE}" max="${EQ_GAIN_RANGE}" step="0.5" value="${
          state.eq.preamp
        }" aria-label="前级增益" />
        <span class="hint" id="eq-preamp-value">${eqGainLabel(state.eq.preamp)}</span>
      </div>
      <p class="settings-hint">${
        state.eq.enabled
          ? "调节会立即生效；部分音源不允许音频处理，此时无法开启。"
          : "开启后音频会经过音效处理，切换音源时可能自动关闭。"
      }</p>
    </div>`;
}

/** Fade a secondary element down, then release it. */
function fadeOutElement(el: HTMLAudioElement, ms: number) {
  const from = el.volume;
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    el.volume = from * (1 - t);
    if (t < 1) {
      requestAnimationFrame(step);
      return;
    }
    el.pause();
    el.removeAttribute("src");
  };
  requestAnimationFrame(step);
}

/** Overlap the old track with the new one so switching never cuts mid-beat. */
function crossfadeOutCurrent(ms = 420) {
  if (!state.playing) return;
  const src = audio.getAttribute("src");
  if (!src) return;
  try {
    crossfadeAudio.src = src;
    crossfadeAudio.currentTime = audio.currentTime;
    crossfadeAudio.volume = audio.volume;
    void crossfadeAudio.play().catch(() => {
      /* the old source may already be gone */
    });
    fadeOutElement(crossfadeAudio, ms);
  } catch {
    /* crossfade is a nicety — never block the switch */
  }
}

/** Flat stroke speaker icons — match the rest of the chrome. */
function volumeIconSvg(vol: number, muted: boolean): string {
  const off = muted || vol <= 0.001;
  if (off) {
    return `<svg class="vol-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="m22 9-6 6"/><path d="m16 9 6 6"/></svg>`;
  }
  if (vol < 0.35) {
    return `<svg class="vol-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/></svg>`;
  }
  if (vol < 0.7) {
    return `<svg class="vol-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 12a3.5 3.5 0 0 0-1.2-2.6"/></svg>`;
  }
  return `<svg class="vol-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5.5 5.5 0 0 1 0 7"/><path d="M18.2 5.8a9 9 0 0 1 0 12.4"/></svg>`;
}

function paintMuteButton() {
  const btn = document.querySelector("#btn-mute");
  if (!btn) return;
  btn.innerHTML = volumeIconSvg(state.volume, state.muted);
  btn.setAttribute("title", state.muted || state.volume <= 0.001 ? "取消静音" : "静音");
}

/** Shared inline SVG icon set — 24×24, stroke style matches volumeIconSvg. */
function iconSvg(inner: string, filled = false): string {
  const attrs = filled
    ? 'fill="currentColor" stroke="none"'
    : 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
  return `<svg viewBox="0 0 24 24" aria-hidden="true" ${attrs}>${inner}</svg>`;
}

const HEART_PATH =
  "M12 20.2C6.6 16.8 3.2 13.6 3.2 10.3c0-2.5 2-4.5 4.5-4.5 1.7 0 3.2.9 4.3 2.3 1.1-1.4 2.6-2.3 4.3-2.3 2.5 0 4.5 2 4.5 4.5 0 3.3-3.4 6.5-8.8 9.9z";
const MUSIC_NOTE_PATH = "M9 18V5l12-2v13";

const ICO = {
  discover: iconSvg(
    `<circle cx="12" cy="12" r="9"/><path class="needle" d="m14.9 9.1-1.7 4.1-4.1 1.7 1.7-4.1z"/>`,
  ),
  heart: iconSvg(`<path d="${HEART_PATH}"/>`),
  heartFill: iconSvg(`<path d="${HEART_PATH}"/>`, true),
  gear: iconSvg(
    `<circle cx="12" cy="12" r="3.1"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
  ),
  play: iconSvg(`<path d="M8 5.4v13.2L18.6 12z"/>`, true),
  pause: iconSvg(`<path d="M6.6 5h3.4v14H6.6zM14 5h3.4v14H14z"/>`, true),
  prev: iconSvg(`<path d="M6 5h2.4v14H6z"/><path d="M20 5v14L9.8 12z"/>`, true),
  next: iconSvg(`<path d="M15.6 5H18v14h-2.4z"/><path d="M4 5v14l10.2-7z"/>`, true),
  note: iconSvg(`<path d="${MUSIC_NOTE_PATH}"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>`),
  spinner: `<svg class="spin" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5" stroke-dasharray="14 40"/></svg>`,
};

function applyVolume(next: number, opts?: { persist?: boolean; fromMute?: boolean }) {
  const v = Math.min(1, Math.max(0, next));
  state.volume = v;
  if (!opts?.fromMute) {
    state.muted = v <= 0.001;
    if (v > 0.001) state.volumeBeforeMute = v;
  }
  // Cancel any running fade so the slider wins immediately.
  fadeToken += 1;
  audio.volume = state.muted ? 0 : v;
  if (opts?.persist !== false && !state.muted) persistVolume(v);
  const slider = document.querySelector<HTMLInputElement>("#volume");
  if (slider && document.activeElement !== slider) slider.value = String(v);
  paintMuteButton();
}

/** Effective volume when not fading — muted tracks ramp to 0. */
function baseVolume(): number {
  return state.muted ? 0 : state.volume;
}

/** Bumped on every ramp / manual volume change so stale ramps stop writing. */
let fadeToken = 0;

/** Short linear volume ramp. Only touches `audio.volume`, never `state.volume`. */
function rampVolume(target: number, ms: number): Promise<void> {
  const token = ++fadeToken;
  const from = audio.volume;
  const to = Math.min(1, Math.max(0, target));
  if (Math.abs(to - from) < 0.001) {
    audio.volume = to;
    return Promise.resolve();
  }
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const step = (now: number) => {
      if (token !== fadeToken) {
        resolve();
        return;
      }
      const p = Math.min(1, (now - startedAt) / ms);
      audio.volume = from + (to - from) * p;
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

/** Fade to silence, then pause — unless another ramp superseded us. */
async function fadeOutAndPause() {
  const token = fadeToken + 1;
  await rampVolume(0, 180);
  if (token !== fadeToken) return;
  audio.pause();
}

function toggleMute() {
  if (state.muted || state.volume <= 0.001) {
    const restore = state.volumeBeforeMute > 0.001 ? state.volumeBeforeMute : 0.85;
    state.muted = false;
    applyVolume(restore);
  } else {
    state.volumeBeforeMute = state.volume > 0.001 ? state.volume : state.volumeBeforeMute;
    state.muted = true;
    void rampVolume(0, 120);
    paintMuteButton();
  }
}

/** True when focus sits in a text field or an overlay owns the keyboard. */
function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return el.isContentEditable;
}

function handleShortcut(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (state.dialog || state.contextMenu) return;
  if (isTypingTarget(e.target)) return;

  switch (e.key) {
    case " ":
      // Let a focused button/row handle its own Space activation.
      if ((e.target as HTMLElement | null)?.closest?.("button, [role='button']")) return;
      if (!state.current) return;
      e.preventDefault();
      playPause();
      break;
    case "ArrowLeft":
      e.preventDefault();
      nudgeSeek(-5);
      break;
    case "ArrowRight":
      e.preventDefault();
      nudgeSeek(5);
      break;
    case "ArrowUp":
      e.preventDefault();
      applyVolume(state.volume + 0.05);
      toast(`音量 ${Math.round(state.volume * 100)}%`);
      break;
    case "ArrowDown":
      e.preventDefault();
      applyVolume(state.volume - 0.05);
      toast(`音量 ${Math.round(state.volume * 100)}%`);
      break;
    case "m":
    case "M":
      e.preventDefault();
      toggleMute();
      break;
    default:
      break;
  }
}

function nudgeSeek(delta: number) {
  const dur = audio.duration || state.duration || 0;
  if (!dur) return;
  seekTo(state.position + delta);
  syncLyricsHighlight({ forceScroll: true });
}

/** How many track rows fit in the main scroll area. */
function calcListPageSize(): number {
  const scroll = document.querySelector(".page-scroll") as HTMLElement | null;
  const h = scroll?.clientHeight || Math.max(320, window.innerHeight - 220);
  const reserved = 118; // title + section head + pager
  const rowH = 58;
  return Math.max(5, Math.min(12, Math.floor((h - reserved) / rowH)));
}

/** @deprecated alias — search uses the same viewport sizing */
function calcSearchPageSize(): number {
  return calcListPageSize();
}

/** Per-source API limit so interleaved results ≈ one screen. */
function searchLimitPerSource(pageSize: number): number {
  const sources = Math.max(1, state.settings.enabledSources?.length || 1);
  return Math.max(2, Math.min(10, Math.ceil(pageSize / sources)));
}

function totalPagesFor(count: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, count) / Math.max(1, pageSize)));
}

function clampPage(page: number, count: number, pageSize: number): number {
  return Math.min(Math.max(1, page), totalPagesFor(count, pageSize));
}

function slicePage<T>(items: T[], page: number, pageSize: number) {
  const total = items.length;
  const totalPages = totalPagesFor(total, pageSize);
  const safePage = clampPage(page, total, pageSize);
  const start = (safePage - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page: safePage,
    totalPages,
    total,
    startIndex: start,
  };
}

function renderPager(opts: {
  key: string;
  page: number;
  totalPages: number;
  ariaLabel: string;
}): string {
  if (opts.totalPages <= 1) return "";
  return `
    <div class="pager" role="navigation" aria-label="${escapeAttr(opts.ariaLabel)}" data-pager="${escapeAttr(opts.key)}">
      <button class="btn ghost sm" type="button" data-page-delta="-1" ${opts.page <= 1 ? "disabled" : ""}>上一页</button>
      <span class="pager-indicator">第 ${opts.page} / ${opts.totalPages} 页</span>
      <button class="btn ghost sm" type="button" data-page-delta="1" ${
        opts.page >= opts.totalPages ? "disabled" : ""
      }>下一页</button>
    </div>
  `;
}

function browsingPlaylist(): RecommendPlaylist | null {
  const id = state.browsePlaylistId;
  if (!id) return null;
  return state.recommend?.hotPlaylists.find((p) => p.id === id) ?? null;
}

function clearBrowse() {
  state.browsePlaylistId = null;
  state.browsePage = 1;
  // Playlist / search navigation always leaves the artist or album drill-down.
  state.detail = null;
}

function openRecommendPlaylist(pl: RecommendPlaylist) {
  clearSearchResults();
  state.detail = null;
  state.browsePlaylistId = pl.id;
  state.browsePage = 1;
  state.tab = "discover";
  if (pl.tracks.length) {
    void playTrack(pl.tracks[0], pl.tracks);
  }
  renderMain();
}

/** Case/space-insensitive containment test — sources spell artists differently. */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
}

/** Every track already in memory that passes `pick`, deduped by uid. */
function knownTracksMatching(pick: (t: Track) => boolean): Track[] {
  const pools: Track[][] = [
    state.searchTracks,
    state.searchAccum,
    state.recent,
    state.localTracks,
    state.recommend?.hotTracks ?? [],
    ...(state.recommend?.hotPlaylists ?? []).map((p) => p.tracks),
    (state.library?.favorites ?? []).map(storedToTrack),
    ...(state.library?.playlists ?? []).map((p) =>
      p.tracks.map((t) => storedToTrack(t as LibrarySnapshot["favorites"][number])),
    ),
    state.queue,
  ];
  const seen = new Set<string>();
  const out: Track[] = [];
  for (const pool of pools) {
    for (const track of pool) {
      if (seen.has(track.uid) || !pick(track)) continue;
      seen.add(track.uid);
      out.push(track);
    }
  }
  return out;
}

function detailKeyword(detail: NonNullable<typeof state.detail>): string {
  return detail.kind === "artist"
    ? detail.name
    : `${detail.artist} ${detail.name}`.trim();
}

function openDetail(kind: "artist" | "album", name: string, artist = "") {
  const trimmed = name.trim();
  if (!trimmed) return;
  state.browsePlaylistId = null;
  state.browsePage = 1;
  state.detail = {
    kind,
    name: trimmed,
    artist: artist.trim(),
    tracks: [],
    loading: true,
    note: "",
    error: "",
    page: 1,
  };
  state.tab = "discover";
  renderMain();
  void loadDetail();
}

/**
 * Sources only expose keyword search, so a detail page = known in-memory tracks
 * for that name + one broad search. Album hits are filtered by album name because
 * the keyword may match unrelated songs.
 */
async function loadDetail() {
  const detail = state.detail;
  if (!detail) return;
  const match = (t: Track) =>
    detail.kind === "artist" ? sameName(t.artist, detail.name) : sameName(t.album, detail.name);
  const merged = knownTracksMatching(match);
  const seen = new Set(merged.map((t) => t.uid));

  let fetched: Track[] = [];
  let error = "";
  try {
    const result = await invoke<SearchPageResult>("search_tracks", {
      keyword: detailKeyword(detail),
      page: 1,
      reset: true,
      limitPerSource: 30,
    });
    fetched = result.tracks ?? [];
  } catch (e) {
    error = String(e);
  }
  if (state.detail !== detail) return;

  let relevant = detail.kind === "album" ? fetched.filter(match) : fetched;
  let note = "";
  if (detail.kind === "album" && !relevant.length && fetched.length) {
    relevant = fetched;
    note = "音源未返回专辑字段，以下为关键词搜索结果";
  }
  for (const track of relevant) {
    if (seen.has(track.uid)) continue;
    seen.add(track.uid);
    merged.push(track);
  }

  detail.tracks = merged;
  detail.loading = false;
  detail.error = error;
  detail.note = note;
  renderMain();
}

/** Hand the detail name over to the regular search page. */
function searchDetailName() {
  const detail = state.detail;
  if (!detail) return;
  const keyword = detailKeyword(detail);
  state.detail = null;
  state.keyword = keyword;
  void doSearch(true);
}

function clearSearchResults() {
  state.searchTracks = [];
  state.searchAccum = [];
  state.searchErrors = [];
  state.searchLoadedMaxPage = 0;
  state.page = 1;
  state.searchHasMore = false;
  state.searchGroupOpen.clear();
}

function mergeSearchAccum(tracks: Track[]) {
  const seen = new Set(state.searchAccum.map((t) => t.uid));
  for (const track of tracks) {
    if (seen.has(track.uid)) continue;
    seen.add(track.uid);
    state.searchAccum.push(track);
  }
}

function formatSearchErrors(errors: SourceSearchError[]): string {
  return errors
    .map((e) => `${SOURCE_LABEL[e.source] || e.source}：${e.message}`)
    .join("；");
}

function emptyState(icon: string, title: string, hint = ""): string {
  return `
    <div class="empty-state">
      <div class="empty-ico" aria-hidden="true">${escapeHtml(icon)}</div>
      <div class="empty-title">${escapeHtml(title)}</div>
      ${hint ? `<div class="empty-hint">${escapeHtml(hint)}</div>` : ""}
    </div>`;
}

function persistLyricPrefs() {
  try {
    localStorage.setItem(LYRIC_FONT_KEY, state.lyricFont);
    localStorage.setItem(LYRIC_OFFSET_KEY, String(state.lyricOffsetDefault));
    localStorage.setItem(LYRIC_OFFSET_MAP_KEY, JSON.stringify(state.lyricOffsetMap));
    localStorage.setItem(LYRIC_TRANSLATION_KEY, state.lyricTranslation ? "1" : "0");
  } catch {
    /* ignore quota */
  }
}

function cycleLyricFont(delta: number) {
  const order: LyricFontSize[] = ["sm", "md", "lg"];
  const i = order.indexOf(state.lyricFont);
  const next = order[Math.max(0, Math.min(order.length - 1, i + delta))];
  if (next === state.lyricFont) return;
  state.lyricFont = next;
  persistLyricPrefs();
  const box = document.querySelector<HTMLElement>(".lyrics");
  if (box) box.dataset.size = next;
  else render();
}

/** Toggle bilingual subtitles and repaint just the lyric list. */
function toggleLyricTranslation() {
  state.lyricTranslation = !state.lyricTranslation;
  persistLyricPrefs();
  patchLyricsPanel();
  // The overlay caches lyrics per track — force a resend with the new layout.
  desktopLyricsSentUid = "";
  pushDesktopLyricsState({ immediate: true, full: true });
  toast(state.lyricTranslation ? "已显示翻译" : "已隐藏翻译");
}

/** Current track's offset — per-track override when present, otherwise the default. */
function currentLyricOffset(): number {
  return lyricOffsetFor(state.current?.uid);
}

function setLyricOffset(value: number) {
  const v = clampLyricOffset(value);
  const uid = state.current?.uid;
  if (uid) {
    if (v === state.lyricOffsetDefault) delete state.lyricOffsetMap[uid];
    else state.lyricOffsetMap[uid] = v;
  } else {
    state.lyricOffsetDefault = v;
  }
  persistLyricPrefs();
}

function nudgeLyricOffset(delta: number) {
  setLyricOffset(currentLyricOffset() + delta);
  const label = document.querySelector("#lyric-offset-label");
  if (label) {
    label.textContent = formatLyricOffset(currentLyricOffset());
  } else {
    render();
  }
  lastLyricScrollIdx = -1;
  syncLyricsHighlight({ forceScroll: true });
}

function formatLyricOffset(v: number): string {
  if (v === 0) return "±0s";
  return `${v > 0 ? "+" : ""}${v}s`;
}

function goLocalListPage(key: string, delta: number) {
  const pageSize = calcListPageSize();
  if (key === "hot") {
    const total = state.recommend?.hotTracks.length ?? 0;
    state.hotPage = clampPage(state.hotPage + delta, total, pageSize);
  } else   if (key === "fav") {
    const total = state.library?.favorites.length ?? 0;
    state.favPage = clampPage(state.favPage + delta, total, pageSize);
  } else if (key === "recent") {
    state.recentPage = clampPage(state.recentPage + delta, state.recent.length, pageSize);
  } else if (key === "browse") {
    const pl = browsingPlaylist();
    const total = pl?.tracks.length ?? 0;
    state.browsePage = clampPage(state.browsePage + delta, total, pageSize);
  } else if (key === "detail" && state.detail) {
    state.detail.page = clampPage(
      state.detail.page + delta,
      state.detail.tracks.length,
      pageSize,
    );
  } else {
    return;
  }
  renderMain();
}

function syncLocalPagesToSize() {
  const pageSize = calcListPageSize();
  state.hotPage = clampPage(state.hotPage, state.recommend?.hotTracks.length ?? 0, pageSize);
  state.favPage = clampPage(state.favPage, state.library?.favorites.length ?? 0, pageSize);
  state.recentPage = clampPage(state.recentPage, state.recent.length, pageSize);
  const pl = browsingPlaylist();
  state.browsePage = clampPage(state.browsePage, pl?.tracks.length ?? 0, pageSize);
  if (state.detail) {
    state.detail.page = clampPage(state.detail.page, state.detail.tracks.length, pageSize);
  }
}

let sleepTimeoutId = 0;
let sleepTickId = 0;

function sleepLabel(): string {
  if (!state.sleep) return "定时";
  if (state.sleep.mode === "track") return "播完停";
  const left = Math.max(0, state.sleep.endsAt - Date.now());
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

function patchSleepBtn() {
  const btn = document.querySelector("#btn-sleep");
  if (!btn) return;
  btn.textContent = sleepLabel();
  btn.classList.toggle("is-active", !!state.sleep);
  btn.setAttribute("title", state.sleep ? "定时关闭中 · 点击调整" : "定时关闭");
}

function clearSleepTimer(silent = false) {
  if (sleepTimeoutId) {
    window.clearTimeout(sleepTimeoutId);
    sleepTimeoutId = 0;
  }
  if (sleepTickId) {
    window.clearInterval(sleepTickId);
    sleepTickId = 0;
  }
  const had = !!state.sleep;
  state.sleep = null;
  patchSleepBtn();
  if (had && !silent) toast("已取消定时");
}

function fireSleepTimer() {
  audio.pause();
  state.playing = false;
  clearSleepTimer(true);
  syncOsMediaPlaybackState(false);
  toast("定时结束，已暂停播放");
  patchSleepBtn();
}

function setSleepMinutes(minutes: number) {
  clearSleepTimer(true);
  const endsAt = Date.now() + minutes * 60_000;
  state.sleep = { mode: "timed", endsAt, minutes };
  sleepTimeoutId = window.setTimeout(() => fireSleepTimer(), minutes * 60_000);
  sleepTickId = window.setInterval(patchSleepBtn, 1000);
  state.dialog = null;
  toast(`将在 ${minutes} 分钟后暂停`);
  patchOverlays();
}

function setSleepAfterTrack() {
  clearSleepTimer(true);
  state.sleep = { mode: "track" };
  state.dialog = null;
  toast("本曲结束后暂停");
  patchOverlays();
}

function openSleepTimerDialog() {
  state.dialog = { kind: "sleep-timer" };
  patchOverlays();
}

/** Prefer https for remote media (Kuwo often returns http://). */
function preferHttps(url: string): string {
  if (url.startsWith("http://")) {
    return `https://${url.slice("http://".length)}`;
  }
  return url;
}

const app = document.querySelector<HTMLDivElement>("#app")!;

function toast(msg: string) {
  state.toast = msg;
  patchToast();
  window.setTimeout(() => {
    if (state.toast === msg) {
      state.toast = "";
      patchToast();
    }
  }, 2200);
}

function patchToast() {
  const el = app.querySelector(".toast");
  if (!el) {
    if (state.toast) render();
    return;
  }
  el.textContent = state.toast;
  el.classList.toggle("hidden", !state.toast);
}

function isAbortError(e: unknown): boolean {
  return (
    (e instanceof DOMException && e.name === "AbortError") ||
    (typeof e === "object" &&
      e !== null &&
      "name" in e &&
      (e as { name: string }).name === "AbortError") ||
    String(e).includes("AbortError")
  );
}

function applyPlatformChrome() {
  const ua = navigator.userAgent || "";
  const android = /android/i.test(ua);
  document.documentElement.classList.toggle("is-android", android);
  // Edge-to-edge WebViews often report 0 safe-area; keep a modest status/nav fallback.
  if (android) {
    document.documentElement.style.setProperty("--sat-fallback", "32px");
    document.documentElement.style.setProperty("--sab-fallback", "18px");
  }
}

function pushOsMediaTrack() {
  const t = state.current;
  if (!t) {
    void syncOsMediaTrack(null, false, 0, 0);
    return;
  }
  // A one-track queue has nothing to skip to — hide those lock-screen buttons.
  syncOsMediaSkipAvailability(state.queue.length > 1, state.queue.length > 1);
  void syncOsMediaTrack(
    {
      title: t.title,
      artist: t.artist,
      album: t.album,
      artworkUrl: t.cover,
    },
    state.playing,
    state.position,
    state.duration || audio.duration || 0,
  );
}

function seekTo(seconds: number) {
  if (!Number.isFinite(seconds)) return;
  const dur = audio.duration || state.duration || 0;
  const next = dur > 0 ? Math.min(Math.max(0, seconds), dur) : Math.max(0, seconds);
  audio.currentTime = next;
  state.position = next;
  patchPlayerChrome();
  syncOsMediaPosition(next, dur);
}

async function boot() {
  applyTheme(state.theme);
  applyPlatformChrome();
  // Kill the default WebView menu (only "Reload") — we show our own on tracks.
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.contextMenu) {
        closeContextMenu();
        return;
      }
      if (state.queueOpen) {
        toggleQueueDrawer(false);
        return;
      }
    }
    handleShortcut(e);
  });
  void initOsMediaControls({
    play: () => {
      if (!state.current) return;
      if (!state.playing) playPause();
    },
    pause: () => {
      if (state.playing) playPause();
    },
    stop: () => {
      audio.pause();
      state.playing = false;
      seekTo(0);
      syncOsMediaPlaybackState(false);
    },
    next: () => skip(1),
    previous: () => skip(-1),
    seek: (seconds) => seekTo(seconds),
    seekBy: (delta) => seekTo(state.position + delta),
  });
  try {
    state.sources = await invoke<SourceInfo[]>("list_sources");
    state.settings = await invoke<AppSettings>("get_settings");
    state.library = await invoke<LibrarySnapshot>("get_library");
    state.defaultDownloadDir = await invoke<string>("get_default_download_dir");
    state.defaultSourcesDir = await invoke<string>("get_default_sources_dir");
    state.settings = {
      ...state.settings,
      downloadDir: state.settings.downloadDir ?? "",
      sourcesDir: state.settings.sourcesDir ?? "",
      enabledSources: state.settings.enabledSources ?? [],
      quality: state.settings.quality || "hq",
    };
    if (isAndroid()) {
      void ensureDownloadDirPresets();
    }
  } catch (e) {
    console.error(e);
  }
  restoreSession();
  audio.playbackRate = state.playRate;
  syncOsMediaPlaybackRate(state.playRate);
  window.addEventListener("pagehide", () => writeSessionNow());
  // Android may kill a backgrounded WebView without firing pagehide.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") writeSessionNow();
  });
  render();
  void refreshRecommend(false);
  void listenRecommendUpdates();
  void listenDownloadProgress();
  void listenPlaybackCommands();
  void listenDesktopLyrics();
  startKaraokeTicker();
  if (state.desktopLyrics.visible) {
    // Re-open silently when the overlay was on before quitting.
    void setDesktopLyrics(true, { silent: true });
  }

  let resizeTimer = 0;
  let lastListPageSize = calcListPageSize();
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      const next = calcListPageSize();
      if (next === lastListPageSize) return;
      lastListPageSize = next;
      syncLocalPagesToSize();
      if (state.searchTracks.length && state.keyword.trim() && !state.searching && !state.browsePlaylistId) {
        void fetchSearchPage(state.page, false);
      } else if (state.browsePlaylistId || state.detail || state.tab === "library" || state.tab === "discover") {
        renderMain();
      }
    }, 280);
  });
}

/** Tray menu / media keys arrive as events from the Rust side. */
async function listenPlaybackCommands() {
  try {
    await listen<string>("playback-command", (event) => {
      switch (event.payload) {
        case "toggle":
          playPause();
          break;
        case "prev":
          skip(-1);
          break;
        case "next":
          skip(1);
          break;
        default:
          break;
      }
    });
  } catch (e) {
    console.error(e);
  }
}

async function listenRecommendUpdates() {
  try {
    await listen<RecommendCatalog>("recommend-updated", (event) => {
      if (Date.now() < ignoreRecommendEventsUntil) return;
      if (state.recommendLoading) return;
      state.recommend = event.payload;
      state.recommendLoading = false;
      // Quiet background update — no second enter animation; keep lyrics/player intact.
      state.recommendReveal = false;
      renderMain();
    });
  } catch (e) {
    console.error(e);
  }
}

/** Boot: read local cache. User click: clear UI → network → skeleton → new content. */
async function refreshRecommend(fromUser = true) {
  state.recommendLoading = true;
  state.recommendReveal = false;
  if (fromUser) {
    ignoreRecommendEventsUntil = Date.now() + 4000;
    // Full refresh: wipe old cards/list so the reload is obvious.
    state.recommend = { hotTracks: [], hotPlaylists: [] };
    state.hotPage = 1;
    clearBrowse();
    renderMain();
  }
  try {
    const catalog = fromUser
      ? await invoke<RecommendCatalog>("refresh_recommend")
      : await invoke<RecommendCatalog>("load_recommend");
    state.recommend = catalog;
    state.hotPage = clampPage(state.hotPage, catalog.hotTracks.length, calcListPageSize());
    if (state.browsePlaylistId && !catalog.hotPlaylists.some((p) => p.id === state.browsePlaylistId)) {
      clearBrowse();
    }
    const empty = !catalog.hotTracks?.length && !catalog.hotPlaylists?.length;
    if (fromUser) {
      state.recommendReveal = !empty;
      toast(empty ? "暂无推荐数据" : "推荐已更新");
    } else if (empty) {
      ignoreRecommendEventsUntil = Date.now() + 4000;
      void invoke<RecommendCatalog>("refresh_recommend")
        .then((fresh) => {
          state.recommend = fresh;
          state.recommendReveal = !!(fresh.hotTracks?.length || fresh.hotPlaylists?.length);
          state.recommendLoading = false;
          renderMain();
          window.setTimeout(() => {
            state.recommendReveal = false;
          }, 600);
        })
        .catch(() => undefined);
    }
  } catch (e) {
    if (fromUser) toast(`刷新失败：${String(e)}`);
  } finally {
    state.recommendLoading = false;
    renderMain();
    if (state.recommendReveal) {
      window.setTimeout(() => {
        state.recommendReveal = false;
      }, 600);
    }
  }
}

async function doSearch(reset = true) {
  const keyword = state.keyword.trim();
  if (!keyword) {
    toast("请输入关键词");
    return;
  }
  pushSearchHistory(keyword);
  state.searchHistoryOpen = false;
  clearBrowse();
  if (reset) state.page = 1;
  state.tab = "discover";
  await fetchSearchPage(state.page, true);
}

function clearSearch() {
  clearSearchResults();
  clearBrowse();
  state.keyword = "";
  state.tab = "discover";
  renderMain();
}

function toggleLyrics(force?: boolean) {
  const next = force ?? !state.lyricsOpen;
  if (next === state.lyricsOpen) return;
  state.lyricsOpen = next;
  const shell = app.querySelector(".app-shell");
  if (!shell) {
    render();
    return;
  }
  shell.classList.toggle("lyrics-open", next);
  patchLyricsPanel();
  patchPlayerDock();
  afterRenderMotion();
}

async function invokeSearchPage(page: number, reset: boolean): Promise<SearchPageResult> {
  const pageSize = calcSearchPageSize();
  const limitPerSource = searchLimitPerSource(pageSize);
  return invoke<SearchPageResult>("search_tracks", {
    keyword: state.keyword.trim(),
    page,
    reset,
    limitPerSource,
  });
}

async function fetchSearchPage(page: number, isNewSearch: boolean) {
  const keyword = state.keyword.trim();
  if (!keyword || page < 1 || state.searching) return;

  const prevPage = state.page;
  const prevTracks = state.searchTracks;
  const prevHasMore = state.searchHasMore;
  const prevErrors = state.searchErrors;
  const pageSize = calcSearchPageSize();
  state.page = page;
  state.searching = true;
  renderMain();
  try {
    // reset:true so each displayed page is independent (backend cache cleared).
    const result = await invokeSearchPage(page, true);
    const tracks = result.tracks ?? [];
    const errors = result.errors ?? [];
    state.searchErrors = errors;

    if (isNewSearch) {
      state.searchAccum = [];
      state.searchLoadedMaxPage = 0;
      state.searchGroupOpen.clear();
    }
    mergeSearchAccum(tracks);
    state.searchLoadedMaxPage = Math.max(state.searchLoadedMaxPage, page);

    if (!tracks.length) {
      if (page > 1) {
        toast(errors.length ? `没有更多了（${formatSearchErrors(errors)}）` : "没有更多了");
        state.page = prevPage;
        state.searchTracks = prevTracks;
        state.searchHasMore = false;
        state.searchErrors = prevErrors;
      } else {
        state.searchTracks = [];
        state.searchHasMore = false;
        if (errors.length) {
          toast(`搜索失败：${formatSearchErrors(errors)}`);
        } else if (isNewSearch) {
          toast("没有找到结果");
        }
      }
      return;
    }

    // Keep one screen of rows even if sources return a bit more.
    state.searchTracks = tracks.slice(0, pageSize);
    state.searchHasMore = tracks.length >= pageSize;
    if (errors.length && isNewSearch) {
      toast(`部分音源失败：${formatSearchErrors(errors)}`);
    }
  } catch (e) {
    toast(String(e));
    state.page = prevPage;
    state.searchTracks = prevTracks;
    state.searchHasMore = prevHasMore;
    state.searchErrors = prevErrors;
  } finally {
    state.searching = false;
    renderMain();
  }
}

/** Silently load the next search page into the play queue without changing the UI page. */
async function extendSearchQueueIfNeeded(): Promise<boolean> {
  if (state.queueKind !== "search") return false;
  if (!state.keyword.trim() || !state.searchHasMore || state.searching) return false;

  const nextPage = state.searchLoadedMaxPage + 1;
  state.searching = true;
  try {
    const result = await invokeSearchPage(nextPage, true);
    const tracks = result.tracks ?? [];
    if (!tracks.length) {
      state.searchHasMore = false;
      if (result.errors?.length) {
        toast(`无法继续加载：${formatSearchErrors(result.errors)}`);
      }
      return false;
    }
    mergeSearchAccum(tracks);
    state.searchLoadedMaxPage = Math.max(state.searchLoadedMaxPage, nextPage);
    state.searchHasMore = tracks.length >= calcSearchPageSize();
    if (result.errors?.length) {
      state.searchErrors = result.errors;
    }

    const currentUid = state.current?.uid;
    state.queue = state.searchAccum.slice();
    state.queueIndex = currentUid
      ? state.queue.findIndex((t) => t.uid === currentUid)
      : state.queueIndex;
    resetShuffleOrder();
    return state.queueIndex >= 0 && state.queueIndex + 1 < state.queue.length;
  } catch (e) {
    toast(`加载下一页失败：${String(e)}`);
    return false;
  } finally {
    state.searching = false;
  }
}

async function goSearchPage(delta: number) {
  const next = state.page + delta;
  if (next < 1) return;
  if (delta > 0 && !state.searchHasMore) {
    toast("没有更多了");
    return;
  }
  await fetchSearchPage(next, false);
}

/** Seek after metadata loads so the browser clamps to the real duration. */
function applyResumePosition(seconds: number) {
  const apply = () => {
    try {
      audio.currentTime = Math.max(0, seconds);
    } catch {
      /* ignore */
    }
    state.position = audio.currentTime || 0;
    patchPlayerChrome();
    syncOsMediaPosition(state.position, state.duration);
  };
  if (audio.readyState >= 1) apply();
  else audio.addEventListener("loadedmetadata", apply, { once: true });
}

/** Rebuild the play queue from the last session — paused, not auto-playing. */
function restoreSession() {
  const saved = loadSession();
  if (!saved) return;
  state.queue = saved.queue;
  state.queueIndex = saved.queueIndex;
  state.queueKind = saved.queueKind;
  state.playMode = saved.playMode;
  const track = saved.queue[saved.queueIndex];
  if (!track) return;
  state.current = track;
  state.position = saved.position;
  state.duration = saved.duration;
  pendingResume = saved.position > 0 ? { uid: track.uid, seconds: saved.position } : null;
}

async function playTrack(track: Track, queue?: Track[], queueKind: null | "search" = null) {
  const gen = ++playGeneration;

  if (queue) {
    state.queue = queue;
    state.queueIndex = queue.findIndex((t) => t.uid === track.uid);
    state.queueKind = queueKind;
    resetShuffleOrder();
  } else if (state.queueIndex < 0 || state.queue[state.queueIndex]?.uid !== track.uid) {
    state.queue = [track];
    state.queueIndex = 0;
    state.queueKind = queueKind;
    resetShuffleOrder();
  }

  state.preparing = true;
  state.current = track;
  state.position = 0;
  state.duration = 0;
  patchPlaybackViews();

  try {
    crossfadeOutCurrent();
    audio.pause();
    // Start silent so the new track fades in instead of cutting in abruptly.
    fadeToken += 1;
    audio.volume = 0;
    const detailed = await invoke<Track>("ensure_playable", { track });
    if (gen !== playGeneration) return;
    if (!detailed.audioUrl) {
      toast("暂无可用播放地址");
      state.preparing = false;
      audio.volume = baseVolume();
      patchPlaybackViews();
      return;
    }
    state.current = detailed;
    state.lyrics = parseLrc(detailed.lrc, {
      translation: detailed.lrcTranslation,
      words: detailed.lrcWords,
    });
    lyricHasWords = state.lyrics.some((line) => !!line.words?.length);
    lastLyricScrollIdx = -1;
    lyricsUserScrollUntil = 0;
    pushDesktopLyricsState({ immediate: true, full: true });
    audio.src = toPlayableSrc(preferHttps(detailed.audioUrl));
    audio.playbackRate = state.playRate;
    if (pendingResume && pendingResume.uid === detailed.uid) {
      applyResumePosition(pendingResume.seconds);
    }
    pendingResume = null;
    await audio.play();
    if (gen !== playGeneration) return;
    void rampVolume(baseVolume(), 220);
    state.playing = true;
    state.duration = audio.duration || 0;
    state.position = audio.currentTime || 0;
    pushRecent(detailed);
    pushOsMediaTrack();
    persistSession();
  } catch (e) {
    if (gen !== playGeneration || isAbortError(e)) return;
    toast(`播放失败：${String(e)}`);
    state.playing = false;
    audio.volume = baseVolume();
    pushOsMediaTrack();
  } finally {
    if (gen === playGeneration) {
      state.preparing = false;
      patchPlaybackViews();
      pushOsMediaTrack();
    }
  }
}

function playPause() {
  if (!state.current) return;
  if (state.playing) {
    void fadeOutAndPause();
    state.playing = false;
  } else if (!audio.getAttribute("src")) {
    // Restored session: audio has no source yet, load it and jump to the saved spot.
    pendingResume = state.position > 0 ? { uid: state.current.uid, seconds: state.position } : null;
    void playTrack(state.current, state.queue, state.queueKind);
  } else {
    audio.volume = 0;
    void audio.play().then(
      () => {
        state.playing = true;
        void rampVolume(baseVolume(), 180);
      },
      (e) => {
        if (!isAbortError(e)) toast(`播放失败：${String(e)}`);
        audio.volume = baseVolume();
      },
    );
  }
  // Button text comes from audio play/pause listeners — avoid full render (lyrics flash).
}

function skip(delta: number) {
  void skipAsync(delta);
}

/** Shuffled permutation of queue indices — every track plays once per cycle. */
let shuffleOrder: number[] = [];
let shuffleCursor = -1;

function buildShuffleOrder(startIndex: number) {
  const order = Array.from({ length: state.queue.length }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const at = order.indexOf(startIndex);
  if (at > 0) {
    order.splice(at, 1);
    order.unshift(startIndex);
  }
  shuffleOrder = order;
  shuffleCursor = 0;
}

function resetShuffleOrder() {
  shuffleOrder = [];
  shuffleCursor = -1;
}

/** Next/previous index in shuffle mode without repeating until the cycle wraps. */
function shuffleStep(delta: number): number {
  const len = state.queue.length;
  if (len <= 1) return state.queueIndex;
  if (shuffleOrder.length !== len || shuffleCursor < 0) buildShuffleOrder(state.queueIndex);

  if (delta > 0) {
    shuffleCursor += 1;
    if (shuffleCursor >= shuffleOrder.length) {
      // Cycle finished — reshuffle so the next round differs.
      buildShuffleOrder(state.queueIndex);
      shuffleCursor = shuffleOrder.length > 1 ? 1 : 0;
    }
  } else {
    shuffleCursor -= 1;
    if (shuffleCursor < 0) {
      shuffleCursor = shuffleOrder.length - 1;
    }
  }
  return shuffleOrder[shuffleCursor] ?? state.queueIndex;
}

async function skipAsync(delta: number) {
  if (!state.queue.length) return;
  if (state.playMode === "shuffle") {
    const next = shuffleStep(delta);
    if (next === state.queueIndex) return;
    state.queueIndex = next;
    void playTrack(state.queue[next], state.queue, state.queueKind);
    return;
  }

  let next = state.queueIndex + delta;
  if (next >= state.queue.length && delta > 0) {
    const extended = await extendSearchQueueIfNeeded();
    if (extended) {
      next = state.queueIndex + 1;
      state.queueIndex = next;
      void playTrack(state.queue[next], state.queue, state.queueKind);
      return;
    }
  }

  if (next < 0 || next >= state.queue.length) {
    if (state.playMode === "list" && state.queue.length) {
      state.queueIndex = delta > 0 ? 0 : state.queue.length - 1;
      void playTrack(state.queue[state.queueIndex], state.queue, state.queueKind);
    }
    return;
  }
  state.queueIndex = next;
  void playTrack(state.queue[next], state.queue, state.queueKind);
}

function cyclePlayMode() {
  const order: PlayMode[] = ["list", "single", "shuffle"];
  const i = order.indexOf(state.playMode);
  state.playMode = order[(i + 1) % order.length];
  resetShuffleOrder();
  persistSession();
  const modeBtn = document.querySelector("#btn-mode-bar");
  if (modeBtn) {
    modeBtn.textContent = modeLabelShort();
    modeBtn.setAttribute("title", modeLabel());
  }
  toast(modeLabel());
}

async function toggleFavorite(track: Track) {
  try {
    const added = await invoke<boolean>("toggle_favorite", { track });
    state.library = await invoke<LibrarySnapshot>("get_library");
    state.favPage = clampPage(
      state.favPage,
      state.library?.favorites.length ?? 0,
      calcListPageSize(),
    );
    toast(added ? "已收藏" : "已取消收藏");
    renderMain();
    patchPlaybackViews();
  } catch (e) {
    toast(String(e));
  }
}

async function saveSettings(next: AppSettings) {
  state.settings = await invoke<AppSettings>("save_settings", { settings: next });
  toast("设置已保存");
  renderMain();
}

async function ensureDownloadDirPresets(): Promise<DownloadDirPreset[]> {
  if (state.downloadDirPresets.length) return state.downloadDirPresets;
  try {
    state.downloadDirPresets = await invoke<DownloadDirPreset[]>("list_download_dir_presets");
  } catch (e) {
    console.error(e);
    state.downloadDirPresets = [];
  }
  return state.downloadDirPresets;
}

async function pickDownloadDir() {
  // Android / iOS: Tauri dialog has no folder picker — offer app-scoped presets.
  if (isAndroid()) {
    const options = await ensureDownloadDirPresets();
    if (!options.length) {
      toast("暂无可用下载目录");
      return;
    }
    state.dialog = { kind: "pick-download-dir", options };
    patchOverlays();
    return;
  }

  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择下载目录",
      defaultPath:
        state.settings.downloadDir.trim() || state.defaultDownloadDir || undefined,
    });
    if (typeof selected === "string" && selected) {
      await saveSettings({ ...state.settings, downloadDir: selected });
    }
  } catch (e) {
    toast(`选择目录失败：${String(e)}`);
  }
}

async function applyDownloadDirPreset(path: string) {
  state.dialog = null;
  patchOverlays();
  const input = document.querySelector<HTMLInputElement>("#download-dir-input");
  if (input) input.value = path;
  await saveSettings({ ...state.settings, downloadDir: path });
}

async function reloadSources() {
  try {
    state.sources = await invoke<SourceInfo[]>("list_sources");
    state.settings = await invoke<AppSettings>("get_settings");
    renderMain();
  } catch (e) {
    toast(String(e));
  }
}

async function importSourceFromUrl() {
  const input = document.querySelector<HTMLInputElement>("#source-url-input");
  const url = input?.value.trim() || "";
  if (!url) {
    toast("请输入音源 URL");
    return;
  }
  try {
    const info = await invoke<SourceInfo>("import_source_from_url", { url });
    toast(`已导入音源：${info.label}`);
    if (input) input.value = "";
    await reloadSources();
  } catch (e) {
    toast(`导入失败：${String(e)}`);
  }
}

async function importSourceFromFile() {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: true,
      title: "选择音源 JSON（可多选）",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    const paths = Array.isArray(selected)
      ? selected.filter((p): p is string => typeof p === "string" && !!p)
      : typeof selected === "string" && selected
        ? [selected]
        : [];
    if (!paths.length) return;

    const labels: string[] = [];
    const errors: string[] = [];
    for (const path of paths) {
      try {
        const info = await invoke<SourceInfo>("import_source_from_file", { path });
        labels.push(info.label);
      } catch (e) {
        errors.push(`${path.split(/[/\\]/).pop() || path}: ${String(e)}`);
      }
    }
    await reloadSources();
    if (labels.length) {
      toast(`已导入 ${labels.length} 个音源：${labels.join("、")}`);
    }
    if (errors.length) {
      toast(`部分导入失败：${errors[0]}${errors.length > 1 ? ` 等 ${errors.length} 项` : ""}`);
    }
  } catch (e) {
    toast(`导入失败：${String(e)}`);
  }
}

function downloadTrack(track: Track) {
  if (state.downloadingUid === track.uid || state.downloadQueue.some((t) => t.uid === track.uid)) {
    toast("该歌曲已在下载队列中");
    return;
  }
  state.downloadQueue.push(track);
  patchDownloadQueueChip();
  if (state.downloadingUid) {
    toast(`已加入下载队列（队列 ${state.downloadQueue.length}）`);
    return;
  }
  void drainDownloadQueue();
}

/** Add many tracks at once, skipping duplicates and local files. */
function downloadTracks(tracks: Track[]) {
  const pending = new Set([state.downloadingUid, ...state.downloadQueue.map((t) => t.uid)]);
  let added = 0;
  for (const track of tracks) {
    if (track.source === "local" || pending.has(track.uid)) continue;
    pending.add(track.uid);
    state.downloadQueue.push(track);
    added += 1;
  }
  if (!added) {
    toast("没有可下载的歌曲");
    return;
  }
  toast(`已加入 ${added} 首到下载队列`);
  patchDownloadQueueChip();
  if (!state.downloadingUid) void drainDownloadQueue();
}

/** Resolve a batch-download target from a `data-dl-all` key. */
function tracksForDownloadKey(key: string): Track[] {
  if (key === "search") return state.searchTracks;
  if (key === "detail") return state.detail?.tracks ?? [];
  if (key === "hot") return state.recommend?.hotTracks ?? [];
  if (key === "fav") return (state.library?.favorites ?? []).map(storedToTrack);
  if (key === "recent") return state.recent;
  if (key.startsWith("rec-")) {
    const id = key.slice(4);
    return state.recommend?.hotPlaylists.find((p) => p.id === id)?.tracks ?? [];
  }
  if (key.startsWith("pl-")) {
    const playlist = state.library?.playlists.find((p) => p.id === key.slice(3));
    return (playlist?.tracks ?? []).map((t) =>
      storedToTrack(t as LibrarySnapshot["favorites"][number]),
    );
  }
  return [];
}

function downloadQueueLabel(): string {
  const pending = state.downloadQueue.length;
  if (!state.downloadingUid && !pending) return "";
  return pending ? `下载 · 剩 ${pending}` : "下载中";
}

/** Shared "download all" button for list headers. */
function downloadAllButton(key: string, label = "全部下载"): string {
  return `<button class="btn ghost sm" type="button" data-dl-all="${escapeAttr(key)}">${label}</button>`;
}

/** Downloads run one at a time — parallel pulls starve playback bandwidth. */
async function drainDownloadQueue() {
  while (state.downloadQueue.length) {
    const track = state.downloadQueue.shift()!;
    state.downloadingUid = track.uid;
    delete state.downloadProgress[track.uid];
    patchDownloadBadge(track.uid);
    patchDownloadQueueChip();
    try {
      const result = await invoke<{ path: string; alreadyExists: boolean }>("download_track", {
        track,
      });
      toast(
        result.alreadyExists
          ? `已存在，无需重复下载：${result.path}`
          : `已下载：${result.path}`,
      );
    } catch (e) {
      toast(`下载失败：${String(e)}`);
    } finally {
      state.downloadingUid = "";
      delete state.downloadProgress[track.uid];
      patchDownloadBadge(track.uid);
      patchDownloadQueueChip();
    }
  }
  patchDownloadQueueChip();
}

/** Short human-readable byte size, e.g. 3.4M. */
function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  if (n >= 1024) return `${Math.round(n / 1024)}K`;
  return `${n}B`;
}

/** Download icon / percentage shown in each row action group. */
function downloadBadgeText(uid: string): string {
  if (state.downloadingUid !== uid) return "⬇";
  const p = state.downloadProgress[uid];
  if (!p) return "…";
  if (!p.total) return formatBytes(p.downloaded);
  return `${Math.min(100, Math.round((p.downloaded / p.total) * 100))}%`;
}

/** Patch only the affected row so progress ticks don't repaint whole lists. */
function patchDownloadBadge(uid: string) {
  const nodes = document.querySelectorAll<HTMLElement>("[data-dl-uid]");
  nodes.forEach((node) => {
    if (node.dataset.dlUid !== uid) return;
    node.textContent = downloadBadgeText(uid);
    node.classList.toggle("is-downloading", state.downloadingUid === uid);
  });
}

/** Only the queue counter changes on start/finish — repaint that chip alone. */
function patchDownloadQueueChip() {
  const chip = document.querySelector("#dl-queue");
  if (!chip) return;
  const label = downloadQueueLabel();
  chip.textContent = label || "下载";
  chip.classList.toggle("is-active", !!label);
}

async function listenDownloadProgress() {
  try {
    await listen<{ uid: string; downloaded: number; total: number }>(
      "download-progress",
      (event) => {
        const { uid, downloaded, total } = event.payload;
        state.downloadProgress[uid] = { downloaded, total };
        patchDownloadBadge(uid);
      },
    );
  } catch (e) {
    console.error(e);
  }
}

/** Scan the download folder (or a custom dir) for playable audio files. */
async function scanLocalTracks(dir?: string) {
  if (state.localScanning) return;
  state.localScanning = true;
  renderMain();
  try {
    const target = (dir ?? state.settings.downloadDir).trim();
    const tracks = await invoke<Track[]>("scan_local_tracks", { dir: target || null });
    state.localTracks = tracks;
    state.localScanDir = target || state.defaultDownloadDir;
    toast(tracks.length ? `找到 ${tracks.length} 首本地歌曲` : "该目录下没有音频文件");
  } catch (e) {
    toast(`扫描失败：${String(e)}`);
  } finally {
    state.localScanning = false;
    renderMain();
  }
}

function openNewPlaylistDialog() {
  state.dialog = { kind: "new-playlist" };
  patchOverlays();
}

function openRenamePlaylistDialog(id: string, name: string) {
  state.dialog = { kind: "rename-playlist", id, name };
  patchOverlays();
}

function openImportPlaylistDialog() {
  state.dialog = { kind: "import-playlist", url: "" };
  patchOverlays();
}

/** Pull a shared NetEase / QQ playlist into a brand-new local playlist. */
async function submitImportPlaylist(url: string) {
  const trimmed = url.trim();
  if (!trimmed) {
    toast("请粘贴歌单分享链接");
    return;
  }
  state.dialog = { kind: "import-playlist", url: trimmed, busy: true };
  patchOverlays();
  try {
    const playlist = await invoke<StoredPlaylist>("import_playlist_from_url", { url: trimmed });
    state.library = await invoke<LibrarySnapshot>("get_library");
    state.dialog = null;
    state.libraryPane = "playlists";
    toast(`已导入「${playlist.name}」，共 ${playlist.tracks.length} 首`);
    renderMain();
    patchOverlays();
  } catch (e) {
    state.dialog = { kind: "import-playlist", url: trimmed };
    patchOverlays();
    toast(`导入失败：${String(e)}`);
  }
}

async function submitNewPlaylist(name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    toast("请输入歌单名称");
    return;
  }
  try {
    await invoke("create_playlist", { name: trimmed });
    state.library = await invoke<LibrarySnapshot>("get_library");
    state.dialog = null;
    toast(`已创建「${trimmed}」`);
    renderMain();
    patchOverlays();
  } catch (e) {
    toast(String(e));
  }
}

async function submitRenamePlaylist(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) {
    toast("请输入歌单名称");
    return;
  }
  try {
    await invoke("rename_playlist", { id, name: trimmed });
    state.library = await invoke<LibrarySnapshot>("get_library");
    state.dialog = null;
    toast(`已重命名为「${trimmed}」`);
    renderMain();
    patchOverlays();
  } catch (e) {
    toast(String(e));
  }
}

function openDeletePlaylistDialog(id: string, name: string) {
  state.dialog = { kind: "delete-playlist", id, name };
  patchOverlays();
}

async function confirmDeletePlaylist(id: string) {
  try {
    await invoke("delete_playlist", { id });
    state.library = await invoke<LibrarySnapshot>("get_library");
    state.dialog = null;
    toast("歌单已删除");
    renderMain();
    patchOverlays();
  } catch (e) {
    toast(String(e));
  }
}

async function removeTrackFromPlaylist(playlistId: string, trackUid: string) {
  try {
    await invoke("remove_from_playlist", { playlistId, trackUid });
    state.library = await invoke<LibrarySnapshot>("get_library");
    if (state.contextMenu) state.contextMenu = null;
    toast("已从歌单移除");
    renderMain();
    patchOverlays();
  } catch (e) {
    toast(String(e));
  }
}

async function movePlaylistTrack(playlistId: string, fromIndex: number, toIndex: number) {
  try {
    await invoke("move_playlist_track", { playlistId, fromIndex, toIndex });
    state.library = await invoke<LibrarySnapshot>("get_library");
    renderMain();
  } catch (e) {
    toast(String(e));
  }
}

async function exportLibraryBackup() {
  try {
    if (isAndroid()) {
      const path = await invoke<string>("export_library_to_download_dir");
      toast(`已导出：${path}`);
      return;
    }
    const { save } = await import("@tauri-apps/plugin-dialog");
    const stamp = new Date().toISOString().slice(0, 10);
    const path = await save({
      title: "导出收藏与歌单",
      defaultPath: `maoer-library-${stamp}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return;
    await invoke("export_library_to_path", { path });
    toast("已导出备份");
  } catch (e) {
    toast(`导出失败：${String(e)}`);
  }
}

async function pickLibraryImport() {
  try {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const selected = await open({
      multiple: false,
      title: "导入收藏与歌单备份",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    const path = typeof selected === "string" ? selected : null;
    if (!path) return;
    state.dialog = { kind: "import-library", path };
    patchOverlays();
  } catch (e) {
    toast(`选择文件失败：${String(e)}`);
  }
}

async function confirmImportLibrary(path: string) {
  try {
    await invoke("import_library_from_path", { path });
    state.library = await invoke<LibrarySnapshot>("get_library");
    state.dialog = null;
    state.favPage = 1;
    toast("已导入备份（覆盖本地收藏与歌单）");
    renderMain();
    patchOverlays();
  } catch (e) {
    toast(`导入失败：${String(e)}`);
  }
}

function closeDialog() {
  state.dialog = null;
  patchOverlays();
}

function closeContextMenu() {
  if (!state.contextMenu) return;
  state.contextMenu = null;
  patchOverlays();
}

function openTrackContextMenu(e: MouseEvent, trackUid: string, queueKey: string) {
  e.preventDefault();
  e.stopPropagation();
  state.contextMenu = { x: e.clientX, y: e.clientY, trackUid, queueKey };
  patchOverlays();
}

function queueFromKey(key: string): Track[] {
  if (key === "search") {
    return state.searchAccum.length ? state.searchAccum : state.searchTracks;
  }
  if (key === "detail") return state.detail?.tracks.slice() ?? [];
  if (key === "hot") return state.recommend?.hotTracks ?? [];
  if (key === "fav") return (state.library?.favorites ?? []).map(storedToTrack);
  if (key === "recent") return state.recent.slice();
  if (key === "local") return state.localTracks.slice();
  if (key === "browse") {
    return browsingPlaylist()?.tracks.slice() ?? [];
  }
  if (key.startsWith("rec-")) {
    const id = key.slice(4);
    return state.recommend?.hotPlaylists.find((p) => p.id === id)?.tracks.slice() ?? [];
  }
  if (key.startsWith("pl-")) {
    const id = key.slice(3);
    const pl = state.library?.playlists.find((p) => p.id === id);
    return (pl?.tracks ?? []).map((t) => storedToTrack(t as LibrarySnapshot["favorites"][number]));
  }
  return state.queue.length ? state.queue : state.current ? [state.current] : [];
}

function renderQueueDrawer(): string {
  if (!state.queueOpen) return "";
  const tracks = state.queue;
  const rows = tracks.length
    ? tracks
        .map((t, i) => {
          const active = i === state.queueIndex;
          return `
          <div class="queue-row${active ? " active" : ""}" data-queue-jump="${i}" role="button" tabindex="0">
            <span class="idx">${active ? "♪" : String(i + 1).padStart(2, "0")}</span>
            <img class="cover" src="${coverPlaceholder()}"${coverAttrs(t)} alt="" loading="lazy" decoding="async" />
            <div class="meta">
              <div class="title">${escapeHtml(t.title || "未知歌曲")}</div>
              <div class="sub">${escapeHtml(t.artist || "未知歌手")}</div>
            </div>
            <button class="queue-remove" type="button" data-queue-remove="${escapeAttr(t.uid)}" title="移出队列">✕</button>
          </div>`;
        })
        .join("")
    : emptyState("♪", "播放队列是空的", "从列表里选一首歌开始");

  return `
    <div class="queue-backdrop" id="queue-backdrop"></div>
    <section class="queue-drawer" id="queue-drawer" role="dialog" aria-label="播放队列">
      <div class="queue-head">
        <h3>播放队列<span class="queue-count">${tracks.length} 首</span></h3>
        <div class="queue-head-actions">
          <button class="btn ghost sm" id="btn-queue-clear" type="button" ${tracks.length ? "" : "disabled"}>清空</button>
          <button class="icon-btn" id="btn-queue-close" type="button" title="关闭">✕</button>
        </div>
      </div>
      <div class="queue-list">${rows}</div>
    </section>`;
}

function toggleQueueDrawer(force?: boolean) {
  const next = force ?? !state.queueOpen;
  if (next === state.queueOpen) return;
  state.queueOpen = next;
  syncQueueDrawer();
}

/** Re-render only the drawer node so the player and lyrics keep their DOM. */
function syncQueueDrawer() {
  const holder = document.querySelector("#queue-root");
  if (!holder) {
    render();
    return;
  }
  holder.innerHTML = renderQueueDrawer();
  bindQueueEvents();
  hydrateCovers();
}

function playQueueIndex(index: number) {
  const track = state.queue[index];
  if (!track) return;
  state.queueIndex = index;
  void playTrack(track, state.queue, state.queueKind);
  syncQueueDrawer();
}

function removeQueueTrack(uid: string) {
  const index = state.queue.findIndex((t) => t.uid === uid);
  if (index < 0) return;
  const wasCurrent = index === state.queueIndex;
  state.queue = state.queue.filter((t) => t.uid !== uid);
  if (!state.queue.length) {
    state.queueIndex = -1;
    audio.pause();
    state.playing = false;
    state.current = null;
    state.position = 0;
    state.duration = 0;
    writeSessionNow();
    syncQueueDrawer();
    patchPlaybackViews();
    return;
  }
  if (wasCurrent) {
    state.queueIndex = Math.min(index, state.queue.length - 1);
    void playTrack(state.queue[state.queueIndex], state.queue, state.queueKind);
  } else if (index < state.queueIndex) {
    state.queueIndex -= 1;
  }
  resetShuffleOrder();
  persistSession();
  syncQueueDrawer();
}

function clearQueue() {
  if (!state.queue.length) return;
  const current = state.current;
  state.queue = current ? [current] : [];
  state.queueIndex = current ? 0 : -1;
  resetShuffleOrder();
  persistSession();
  toast("已清空播放队列");
  syncQueueDrawer();
}

function renderContextMenu(): string {
  const menu = state.contextMenu;
  if (!menu) return "";
  const track = findTrack(menu.trackUid);
  if (!track) return "";
  const fav = isFavorite(track.uid);
  const inPlaylist = menu.queueKey.startsWith("pl-");
  // Rough clamp before measure; refined after paint in bindEvents.
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 180));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 200));
  return `
    <div class="ctx-backdrop" id="ctx-backdrop"></div>
    <div class="ctx-menu" id="ctx-menu" style="left:${left}px;top:${top}px" role="menu">
      <button type="button" class="ctx-item" data-ctx="play" role="menuitem">播放</button>
      <button type="button" class="ctx-item" data-ctx="add-pl" role="menuitem">加入歌单</button>
      ${
        inPlaylist
          ? `<button type="button" class="ctx-item" data-ctx="remove-pl" role="menuitem">从歌单移除</button>`
          : ""
      }
      <button type="button" class="ctx-item" data-ctx="fav" role="menuitem">${fav ? "取消收藏" : "收藏"}</button>
      ${
        track.source === "local"
          ? ""
          : `<div class="ctx-sep"></div>
      <button type="button" class="ctx-item" data-ctx="download" role="menuitem">下载</button>`
      }
    </div>`;
}

function openAddToPlaylistDialog(trackUid: string) {
  const playlists = state.library?.playlists ?? [];
  if (!playlists.length) {
    toast("先在「我的」里新建一个歌单");
    return;
  }
  state.dialog = { kind: "add-to-playlist", trackUid };
  patchOverlays();
}

async function addTrackToPlaylist(playlistId: string, trackUid: string) {
  const track = findTrack(trackUid);
  if (!track) {
    toast("找不到这首歌");
    return;
  }
  try {
    await invoke("add_to_playlist", { playlistId, track });
    state.library = await invoke<LibrarySnapshot>("get_library");
    const name = state.library.playlists.find((p) => p.id === playlistId)?.name || "歌单";
    state.dialog = null;
    toast(`已加入「${name}」`);
    renderMain();
    patchOverlays();
  } catch (e) {
    toast(String(e));
  }
}

function renderDialog(): string {
  const d = state.dialog;
  if (!d) return "";
  if (d.kind === "new-playlist") {
    return `
      <div class="dialog-backdrop" id="dialog-backdrop">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <h3 id="dialog-title">新建歌单</h3>
          <input id="dialog-input" class="dialog-input" type="text" value="我的歌单" maxlength="40" autocomplete="off" />
          <div class="dialog-actions">
            <button class="btn ghost sm" type="button" id="dialog-cancel">取消</button>
            <button class="btn sm" type="button" id="dialog-ok">创建</button>
          </div>
        </div>
      </div>`;
  }
  if (d.kind === "import-playlist") {
    return `
      <div class="dialog-backdrop" id="dialog-backdrop">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <h3 id="dialog-title">导入在线歌单</h3>
          <p class="dialog-msg">粘贴网易云或 QQ 音乐的歌单分享链接，会新建一个本地歌单。</p>
          <input id="dialog-input" class="dialog-input" type="text" placeholder="https://music.163.com/playlist?id=…" value="${escapeAttr(
            d.url,
          )}" autocomplete="off" ${d.busy ? "disabled" : ""} />
          <div class="dialog-actions">
            <button class="btn ghost sm" type="button" id="dialog-cancel" ${
              d.busy ? "disabled" : ""
            }>取消</button>
            <button class="btn sm" type="button" id="dialog-ok" ${d.busy ? "disabled" : ""}>${
              d.busy ? "导入中…" : "导入"
            }</button>
          </div>
        </div>
      </div>`;
  }
  if (d.kind === "rename-playlist") {
    return `
      <div class="dialog-backdrop" id="dialog-backdrop">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <h3 id="dialog-title">重命名歌单</h3>
          <input id="dialog-input" class="dialog-input" type="text" value="${escapeAttr(d.name)}" maxlength="40" autocomplete="off" />
          <div class="dialog-actions">
            <button class="btn ghost sm" type="button" id="dialog-cancel">取消</button>
            <button class="btn sm" type="button" id="dialog-ok">保存</button>
          </div>
        </div>
      </div>`;
  }
  if (d.kind === "import-library") {
    const fileName = d.path.split(/[/\\]/).pop() || d.path;
    return `
      <div class="dialog-backdrop" id="dialog-backdrop">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <h3 id="dialog-title">导入备份</h3>
          <p class="dialog-msg">将用「${escapeHtml(fileName)}」覆盖当前收藏与自建歌单，此操作不可撤销。确定继续？</p>
          <div class="dialog-actions">
            <button class="btn ghost sm" type="button" id="dialog-cancel">取消</button>
            <button class="btn sm danger" type="button" id="dialog-ok">导入并覆盖</button>
          </div>
        </div>
      </div>`;
  }
  if (d.kind === "sleep-timer") {
    const active = state.sleep
      ? state.sleep.mode === "track"
        ? "当前：播完本曲后暂停"
        : `当前：${state.sleep.minutes} 分钟（剩余 ${sleepLabel()}）`
      : "当前：未开启";
    return `
      <div class="dialog-backdrop" id="dialog-backdrop">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <h3 id="dialog-title">定时关闭</h3>
          <p class="dialog-msg">${escapeHtml(active)}</p>
          <div class="dialog-list">
            <button class="dialog-list-item" type="button" data-sleep="track">
              <span class="dialog-list-name">播完当前</span>
              <span class="dialog-list-meta">本曲结束后暂停</span>
            </button>
            ${[15, 30, 45, 60]
              .map(
                (m) => `
              <button class="dialog-list-item" type="button" data-sleep="${m}">
                <span class="dialog-list-name">${m} 分钟</span>
                <span class="dialog-list-meta">到时暂停播放</span>
              </button>`,
              )
              .join("")}
            ${
              state.sleep
                ? `<button class="dialog-list-item" type="button" data-sleep="off">
                    <span class="dialog-list-name">关闭定时</span>
                    <span class="dialog-list-meta">取消自动暂停</span>
                  </button>`
                : ""
            }
          </div>
          <div class="dialog-actions">
            <button class="btn ghost sm" type="button" id="dialog-cancel">取消</button>
          </div>
        </div>
      </div>`;
  }
  if (d.kind === "add-to-playlist") {
    const track = findTrack(d.trackUid);
    const playlists = state.library?.playlists ?? [];
    return `
      <div class="dialog-backdrop" id="dialog-backdrop">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <h3 id="dialog-title">加入歌单</h3>
          <p class="dialog-msg">${escapeHtml(track ? `${track.title} · ${track.artist}` : "选择歌单")}</p>
          <div class="dialog-list">
            ${playlists
              .map((p) => {
                const already = p.tracks.some((t) => t.uid === d.trackUid);
                return `
                <button class="dialog-list-item" type="button" data-pick-playlist="${escapeAttr(p.id)}" ${already ? "disabled" : ""}>
                  <span class="dialog-list-name">${escapeHtml(p.name)}</span>
                  <span class="dialog-list-meta">${already ? "已在歌单" : `${p.tracks.length} 首`}</span>
                </button>`;
              })
              .join("")}
          </div>
          <div class="dialog-actions">
            <button class="btn ghost sm" type="button" id="dialog-cancel">取消</button>
          </div>
        </div>
      </div>`;
  }
  if (d.kind === "pick-download-dir") {
    return `
      <div class="dialog-backdrop" id="dialog-backdrop">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
          <h3 id="dialog-title">选用下载目录</h3>
          <p class="dialog-msg">手机系统不支持文件夹选择器，请选择应用可用目录：</p>
          <div class="dialog-list">
            ${d.options
              .map(
                (o) => `
              <button class="dialog-list-item" type="button" data-pick-download-dir="${escapeAttr(o.path)}">
                <span class="dialog-list-name">${escapeHtml(o.label)}</span>
                <span class="dialog-list-meta path-meta">${escapeHtml(o.path)}</span>
              </button>`,
              )
              .join("")}
          </div>
          <div class="dialog-actions">
            <button class="btn ghost sm" type="button" id="dialog-cancel">取消</button>
          </div>
        </div>
      </div>`;
  }
  return `
    <div class="dialog-backdrop" id="dialog-backdrop">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <h3 id="dialog-title">删除歌单</h3>
        <p class="dialog-msg">确定删除「${escapeHtml(d.name)}」？歌曲不会从收藏里消失。</p>
        <div class="dialog-actions">
          <button class="btn ghost sm" type="button" id="dialog-cancel">取消</button>
          <button class="btn sm danger" type="button" id="dialog-ok">删除</button>
        </div>
      </div>
    </div>`;
}

/** Inline SVG placeholder shown until the real cover arrives. */
function coverPlaceholder(): string {
  return (
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1b2340"/><stop offset="1" stop-color="#3d8bfd" stop-opacity=".35"/></linearGradient></defs><rect fill="url(#g)" width="120" height="120"/><text x="60" y="68" text-anchor="middle" fill="#a1a6d0" font-size="34">♪</text></svg>`,
    )
  );
}

/**
 * `<img>` attributes that defer the real bitmap to {@link hydrateCovers}.
 * Covers route through the Rust cache, so a re-render costs a map lookup
 * instead of a fresh CDN round-trip.
 */
function coverAttrs(track: Track | null | undefined, variant: "thumb" | "full" = "thumb"): string {
  const raw = track?.cover?.trim();
  if (!raw) return "";
  return ` data-cover="${escapeAttr(preferHttps(raw))}" data-cover-variant="${variant}"`;
}

/** url|variant → data URL, so paging back and forth never re-invokes Rust. */
const coverMemCache = new Map<string, string>();
const coverInflight = new Map<string, Promise<string | null>>();
const COVER_CONCURRENCY = 4;
let coverActive = 0;
const coverWaiters: Array<() => void> = [];

async function acquireCoverSlot(): Promise<void> {
  if (coverActive < COVER_CONCURRENCY) {
    coverActive += 1;
    return;
  }
  // Park until a running request hands its slot over; the releaser increments
  // on our behalf so the count can never drift above the limit.
  await new Promise<void>((resolve) => coverWaiters.push(resolve));
}

function releaseCoverSlot() {
  const next = coverWaiters.shift();
  if (next) {
    next();
  } else {
    coverActive -= 1;
  }
}

async function loadCover(url: string, variant: string): Promise<string | null> {
  const key = `${variant}|${url}`;
  const cached = coverMemCache.get(key);
  if (cached) return cached;
  const running = coverInflight.get(key);
  if (running) return running;

  await acquireCoverSlot();

  const task = (async () => {
    try {
      const data = await invoke<string>("fetch_cover", { url, variant });
      coverMemCache.set(key, data);
      return data;
    } catch {
      return null;
    } finally {
      coverInflight.delete(key);
      releaseCoverSlot();
    }
  })();
  coverInflight.set(key, task);
  return task;
}

let coverObserver: IntersectionObserver | null = null;

function fillCover(img: HTMLImageElement) {
  const url = img.dataset.cover;
  if (!url) return;
  const variant = img.dataset.coverVariant === "full" ? "full" : "thumb";
  // Already in memory: paint synchronously so paging back does not flicker.
  const hit = coverMemCache.get(`${variant}|${url}`);
  if (hit) {
    img.src = hit;
    img.classList.add("cover-loaded");
    return;
  }
  void loadCover(url, variant).then((data) => {
    // The element may have been replaced by a newer render in the meantime.
    if (!data || !img.isConnected || img.dataset.cover !== url) return;
    img.src = data;
    img.classList.add("cover-loaded");
  });
}

/** Start loading covers that are (or are about to be) on screen. */
function hydrateCovers() {
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>("img[data-cover]"));
  if (!imgs.length) return;
  if (typeof IntersectionObserver !== "function") {
    imgs.forEach(fillCover);
    return;
  }
  coverObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        coverObserver?.unobserve(entry.target);
        fillCover(entry.target as HTMLImageElement);
      }
    },
    { rootMargin: "300px 0px" },
  );
  for (const img of imgs) {
    if (img.dataset.coverBound) continue;
    img.dataset.coverBound = "1";
    coverObserver.observe(img);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function findTrack(uid: string): Track | undefined {
  return (
    state.searchTracks.find((t) => t.uid === uid) ||
    state.searchAccum.find((t) => t.uid === uid) ||
    state.detail?.tracks.find((t) => t.uid === uid) ||
    state.recent.find((t) => t.uid === uid) ||
    state.localTracks.find((t) => t.uid === uid) ||
    state.recommend?.hotTracks.find((t) => t.uid === uid) ||
    state.recommend?.hotPlaylists.flatMap((p) => p.tracks).find((t) => t.uid === uid) ||
    state.library?.favorites.map(storedToTrack).find((t) => t.uid === uid) ||
    state.library?.playlists
      .flatMap((p) => p.tracks)
      .map((t) => storedToTrack(t as LibrarySnapshot["favorites"][number]))
      .find((t) => t.uid === uid) ||
    state.queue.find((t) => t.uid === uid) ||
    (state.current?.uid === uid ? state.current : undefined)
  );
}

function isFavorite(uid: string): boolean {
  return !!state.library?.favorites.some((t) => t.uid === uid);
}

function favButton(uid: string): string {
  const on = isFavorite(uid);
  return `<span class="fav-btn${on ? " is-fav" : ""}" data-fav-uid="${escapeAttr(uid)}" title="${on ? "取消收藏" : "收藏"}" role="button" aria-pressed="${on}">${on ? ICO.heartFill : ICO.heart}</span>`;
}

function storedToTrack(s: LibrarySnapshot["favorites"][number]): Track {
  return {
    uid: s.uid,
    source: (s.source as Track["source"]) || "netease",
    displayIndex: Number(s.displayIndex ?? 1),
    keyword: String(s.keyword ?? ""),
    songId: String(s.songId ?? s.songid ?? ""),
    songMid: String(s.songMid ?? ""),
    qqId: String(s.qqId ?? ""),
    qqSearchKey: String(s.qqSearchKey ?? ""),
    qqIndex: Number(s.qqIndex ?? 0),
    title: s.title,
    artist: s.artist,
    album: String(s.album ?? ""),
    cover: s.cover,
    detailsLoaded: false,
  };
}

function trackRow(track: Track, index: number, queueKey = "", listLen = 0, altCount = 0, groupKey = "") {
  const active = state.current?.uid === track.uid;
  const idx = String(index + 1).padStart(2, "0");
  const dlBusy = state.downloadingUid === track.uid;
  const playlistId = queueKey.startsWith("pl-") ? queueKey.slice(3) : "";
  const plActions = playlistId
    ? `
        <span class="fav-btn${index <= 0 ? " is-disabled" : ""}" data-pl-move="up" data-pl-id="${escapeAttr(playlistId)}" data-pl-index="${index}" title="上移" role="button" aria-disabled="${index <= 0}">↑</span>
        <span class="fav-btn${index >= listLen - 1 ? " is-disabled" : ""}" data-pl-move="down" data-pl-id="${escapeAttr(playlistId)}" data-pl-index="${index}" title="下移" role="button" aria-disabled="${index >= listLen - 1}">↓</span>
        <span class="fav-btn" data-pl-remove-uid="${escapeAttr(track.uid)}" data-pl-id="${escapeAttr(playlistId)}" title="从歌单移除" role="button">✕</span>`
    : `<span class="fav-btn" data-add-pl-uid="${escapeAttr(track.uid)}" title="加入歌单" role="button">＋</span>`;
  const sourceBadge =
    altCount > 0
      ? `<span class="badge badge-multi" data-group-toggle="${escapeAttr(groupKey)}" title="展开其他音源版本" role="button">${escapeHtml(
          SOURCE_LABEL[track.source] || track.source,
        )} +${altCount}${state.searchGroupOpen.has(groupKey) ? " −" : ""}</span>`
      : `<span class="badge">${escapeHtml(SOURCE_LABEL[track.source] || track.source)}</span>`;
  return `
    <button class="track-row ${active ? "active" : ""}" type="button" data-play-uid="${escapeAttr(track.uid)}">
      <span class="idx" data-idx="${idx}">${active && state.playing ? "♪" : idx}</span>
      <img class="cover" src="${coverPlaceholder()}"${coverAttrs(track)} alt="" loading="lazy" decoding="async" />
      <div class="meta">
        <div class="title">${escapeHtml(track.title || "未知歌曲")}</div>
        <div class="sub">${
          track.album
            ? `<span class="album-link" data-album="${escapeAttr(track.album)}" data-album-artist="${escapeAttr(
                track.artist,
              )}" title="查看专辑">${escapeHtml(track.album)}</span>`
            : "单曲"
        }</div>
      </div>
      <div class="artist-col">${
        track.artist
          ? `<span class="artist-link" data-artist="${escapeAttr(track.artist)}" title="查看歌手">${escapeHtml(
              track.artist,
            )}</span>`
          : "未知歌手"
      }</div>
      ${sourceBadge}
      <div class="row-actions">
        ${plActions}
        ${
          track.source === "local"
            ? ""
            : `<span class="fav-btn${dlBusy ? " is-downloading" : ""}" data-dl-uid="${escapeAttr(track.uid)}" title="下载" role="button">${downloadBadgeText(track.uid)}</span>`
        }
        ${favButton(track.uid)}
      </div>
    </button>
  `;
}

/** Case/punctuation-insensitive key used to spot the same song across sources. */
function songKey(track: Track): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .replace(/[（(【\[].*?[）)】\]]/g, "")
      .replace(/[\s\-_·・,.，。!！?？'"“”‘’]/g, "");
  return `${norm(track.title)}|${norm(track.artist)}`;
}

interface TrackGroup {
  key: string;
  primary: Track;
  alternates: Track[];
}

/** Collapse same title+artist hits from different sources into one group. */
function groupTracks(tracks: Track[]): TrackGroup[] {
  const order: TrackGroup[] = [];
  const byKey = new Map<string, TrackGroup>();
  for (const track of tracks) {
    const key = songKey(track);
    const found = byKey.get(key);
    if (found) {
      if (found.primary.uid !== track.uid && !found.alternates.some((t) => t.uid === track.uid)) {
        found.alternates.push(track);
      }
      continue;
    }
    const group: TrackGroup = { key, primary: track, alternates: [] };
    byKey.set(key, group);
    order.push(group);
  }
  return order;
}

function trackList(
  tracks: Track[],
  queueKey: string,
  startIndex = 0,
  group = false,
): string {
  if (!tracks.length) return emptyState("♪", "暂无歌曲", "换个关键词或稍后再试");
  const rows = group
    ? groupTracks(tracks)
        .map((g, i) => {
          const open = state.searchGroupOpen.has(g.key);
          const primary = trackRow(
            g.primary,
            startIndex + i,
            queueKey,
            0,
            g.alternates.length,
            g.key,
          );
          if (!open || !g.alternates.length) return primary;
          const alts = g.alternates
            .map((t) => trackRow(t, startIndex + i, queueKey).replace("track-row", "track-row alt-row"))
            .join("");
          return primary + alts;
        })
        .join("")
    : tracks.map((t, i) => trackRow(t, startIndex + i, queueKey, startIndex + tracks.length)).join("");
  return `
    <div class="track-list" data-queue="${escapeAttr(queueKey)}">
      <div class="track-list-head">
        <span>#</span><span></span><span>歌曲</span><span class="col-artist">歌手</span><span>来源</span><span></span>
      </div>
      ${rows}
    </div>
  `;
}

function renderDetail(detail: NonNullable<typeof state.detail>): string {
  const label = detail.kind === "artist" ? "歌手" : "专辑";
  const sliced = slicePage(detail.tracks, detail.page, calcListPageSize());
  detail.page = sliced.page;
  return `
    <h1 class="page-title">${escapeHtml(detail.name)}<span class="sub">${label}${
      detail.kind === "album" && detail.artist ? ` · ${escapeHtml(detail.artist)}` : ""
    } · ${detail.loading ? "加载中…" : `共 ${sliced.total} 首`}</span></h1>
    ${
      detail.note
        ? `<div class="search-error-banner" role="status">${escapeHtml(detail.note)}</div>`
        : ""
    }
    ${
      detail.error
        ? `<div class="search-error-banner" role="status">加载失败：${escapeHtml(detail.error)}</div>`
        : ""
    }
    <div class="section">
      <div class="section-head">
        <h2>歌曲</h2>
        <div class="section-actions">
          ${renderPager({
            key: "detail",
            page: sliced.page,
            totalPages: sliced.totalPages,
            ariaLabel: `${label}分页`,
          })}
          ${detail.tracks.length ? downloadAllButton("detail") : ""}
          <button class="btn ghost sm" type="button" id="btn-detail-search">在搜索中查看更多</button>
        </div>
      </div>
      ${
        detail.loading && !detail.tracks.length
          ? trackSkeleton(6)
          : detail.tracks.length
            ? trackList(sliced.items, "detail", sliced.startIndex)
            : emptyState(
                "⌕",
                "没有找到相关歌曲",
                detail.kind === "artist" ? "试试在搜索中查看更多" : "音源可能没有收录这张专辑",
              )
      }
    </div>
  `;
}

function renderDiscover(): string {
  if (state.detail) return renderDetail(state.detail);
  const playlists = state.recommend?.hotPlaylists ?? [];
  const pageSize = calcListPageSize();
  const browsing = browsingPlaylist();
  const hasSearch = state.searchTracks.length > 0 && !browsing;

  if (browsing) {
    const sliced = slicePage(browsing.tracks, state.browsePage, pageSize);
    state.browsePage = sliced.page;
    return `
      <h1 class="page-title">${escapeHtml(browsing.name)}<span class="sub">${escapeHtml(browsing.subtitle)} · 共 ${sliced.total} 首 · 第 ${sliced.page} 页</span></h1>
      <div class="section">
        <div class="section-head">
          <h2>歌曲</h2>
          <div class="section-actions">
            ${renderPager({
              key: "browse",
              page: sliced.page,
              totalPages: sliced.totalPages,
              ariaLabel: "歌单分页",
            })}
            ${downloadAllButton(`rec-${browsing.id}`)}
          </div>
        </div>
        ${trackList(sliced.items, `rec-${browsing.id}`, sliced.startIndex)}
      </div>
    `;
  }

  if (hasSearch || (state.keyword.trim() && (state.searching || state.searchErrors.length))) {
    const errorBanner = state.searchErrors.length
      ? `<div class="search-error-banner" role="status">部分音源不可用：${escapeHtml(formatSearchErrors(state.searchErrors))}</div>`
      : "";
    return `
      <h1 class="page-title">搜索结果<span class="sub">第 ${state.page} 页 · 本页 ${state.searchTracks.length} 首 · 「${escapeHtml(state.keyword)}」</span></h1>
      ${errorBanner}
      <div class="section">
        <div class="section-head">
          <h2>歌曲</h2>
          <div class="section-actions">
            <div class="pager" role="navigation" aria-label="搜索分页">
              <button class="btn ghost sm" id="btn-search-prev" type="button" ${
                state.searching || state.page <= 1 ? "disabled" : ""
              }>上一页</button>
              <span class="pager-indicator">第 ${state.page} 页</span>
              <button class="btn ghost sm" id="btn-search-next" type="button" ${
                state.searching || !state.searchHasMore ? "disabled" : ""
              }>下一页</button>
            </div>
            ${downloadAllButton("search")}
          </div>
        </div>
        ${
          state.searchTracks.length
            ? trackList(state.searchTracks, "search", 0, true)
            : state.searching
              ? emptyState("…", "搜索中", "正在向各音源查询")
              : emptyState("⌕", "没有找到结果", "换个关键词，或检查音源是否可用")
        }
      </div>
    `;
  }

  const hotAll = state.recommend?.hotTracks ?? [];
  const hot = slicePage(hotAll, state.hotPage, pageSize);
  state.hotPage = hot.page;
  const refreshing = state.recommendLoading;
  const reveal = state.recommendReveal && !refreshing;
  return `
    <h1 class="page-title">发现<span class="sub">多音源推荐与榜单</span></h1>
    <section class="section ${refreshing ? "is-refreshing" : reveal ? "rec-enter" : ""}">
      <div class="section-head">
        <h2>推荐歌单</h2>
        <button class="btn ghost sm btn-refresh" id="btn-refresh-rec" type="button" ${refreshing ? "disabled" : ""}>
          <span class="refresh-ico ${refreshing ? "spin" : ""}" aria-hidden="true">↻</span>
          ${refreshing ? "刷新中" : "刷新"}
        </button>
      </div>
      <div class="playlist-grid">
        ${
          refreshing
            ? playlistSkeleton(4)
            : playlists.length
              ? playlists
                  .map(
                    (p, i) => `
          <button class="playlist-card rec-item" type="button" style="--i:${i}" data-playlist-id="${escapeAttr(p.id)}">
            <div class="cover-wrap">
              <img src="${escapeAttr(coverPlaceholder())}"${coverAttrs({ cover: p.cover || p.tracks[0]?.cover } as Track)} alt="" loading="lazy" decoding="async" />
              <span class="play-badge">${ICO.play}</span>
            </div>
            <div class="title">${escapeHtml(p.name)}</div>
            <div class="sub">${escapeHtml(p.subtitle)} · ${p.trackCount} 首</div>
          </button>`,
                  )
                  .join("")
              : emptyState("▦", "暂无歌单", "下拉刷新或稍后再试")
        }
      </div>
    </section>
    <section class="section ${refreshing ? "is-refreshing" : reveal ? "rec-enter" : ""}">
      <div class="section-head">
        <h2>热门歌曲</h2>
        ${
          refreshing
            ? `<span class="hint">正在拉取最新推荐…</span>`
            : `<div class="section-actions">
                ${
                  renderPager({
                    key: "hot",
                    page: hot.page,
                    totalPages: hot.totalPages,
                    ariaLabel: "热门歌曲分页",
                  }) || `<span class="hint">点击即播 · 共 ${hot.total} 首</span>`
                }
                ${hot.items.length ? downloadAllButton("hot") : ""}
              </div>`
        }
      </div>
      ${refreshing ? trackSkeleton(8) : trackList(hot.items, "hot", hot.startIndex)}
    </section>
  `;
}

function playlistSkeleton(count: number): string {
  return Array.from({ length: count }, (_, i) => `
    <div class="playlist-card skeleton-card" style="--i:${i}">
      <div class="cover-wrap skel"></div>
      <div class="skel-line"></div>
      <div class="skel-line short"></div>
    </div>
  `).join("");
}

function trackSkeleton(count: number): string {
  return `
    <div class="track-list skeleton-list">
      ${Array.from({ length: count }, (_, i) => `
        <div class="track-row skeleton-row" style="--i:${i}">
          <span class="skel skel-idx"></span>
          <span class="skel skel-cover"></span>
          <div class="meta">
            <div class="skel-line"></div>
            <div class="skel-line short"></div>
          </div>
          <div class="skel-line mid"></div>
          <span class="skel skel-badge"></span>
          <span></span>
        </div>
      `).join("")}
    </div>
  `;
}

function renderLibrary(): string {
  const favsAll = (state.library?.favorites ?? []).map(storedToTrack);
  const favs = slicePage(favsAll, state.favPage, calcListPageSize());
  state.favPage = favs.page;
  const recent = slicePage(state.recent, state.recentPage, calcListPageSize());
  state.recentPage = recent.page;
  const playlists = state.library?.playlists ?? [];
  const pane = state.libraryPane;
  return `
    <h1 class="page-title page-title-sm">我的<span class="sub">收藏、最近与自建歌单</span></h1>
    <div class="library-stack">
      <div class="lib-toolbar">
        <div class="lib-tabs" role="tablist">
          <button type="button" class="lib-tab ${pane === "favorites" ? "active" : ""}" data-lib-pane="favorites" role="tab" aria-selected="${pane === "favorites"}">
            喜欢 · ${favsAll.length}
          </button>
          <button type="button" class="lib-tab ${pane === "recent" ? "active" : ""}" data-lib-pane="recent" role="tab" aria-selected="${pane === "recent"}">
            最近 · ${state.recent.length}
          </button>
          <button type="button" class="lib-tab ${pane === "playlists" ? "active" : ""}" data-lib-pane="playlists" role="tab" aria-selected="${pane === "playlists"}">
            歌单 · ${playlists.length}
          </button>
          <button type="button" class="lib-tab ${pane === "local" ? "active" : ""}" data-lib-pane="local" role="tab" aria-selected="${pane === "local"}">
            本地 · ${state.localTracks.length}
          </button>
        </div>
        <div class="lib-pane-actions">
          <button class="btn ghost sm" id="btn-export-library" type="button">导出备份</button>
          <button class="btn ghost sm" id="btn-import-library" type="button">导入备份</button>
        </div>
      </div>
      ${
        pane === "favorites"
          ? `<section class="lib-pane">
              ${
                favsAll.length
                  ? `<div class="section-head compact">
                      <h2>我喜欢</h2>
                      <div class="section-actions">
                        ${
                          renderPager({
                            key: "fav",
                            page: favs.page,
                            totalPages: favs.totalPages,
                            ariaLabel: "我喜欢分页",
                          }) || `<span class="hint">共 ${favs.total} 首</span>`
                        }
                        ${downloadAllButton("fav")}
                      </div>
                    </div>
                    ${trackList(favs.items, "fav", favs.startIndex)}`
                  : emptyState("♡", "还没有收藏", "去发现页点红心，喜欢的歌会出现在这里")
              }
            </section>`
          : pane === "recent"
            ? `<section class="lib-pane">
                ${
                  state.recent.length
                    ? `<div class="section-head compact">
                        <h2>最近播放</h2>
                        <div class="section-actions">
                          ${
                            renderPager({
                              key: "recent",
                              page: recent.page,
                              totalPages: recent.totalPages,
                              ariaLabel: "最近播放分页",
                            }) || `<span class="hint">共 ${recent.total} 首</span>`
                          }
                          <button class="btn ghost sm" id="btn-clear-recent" type="button">清空</button>
                          ${downloadAllButton("recent")}
                        </div>
                      </div>
                      ${trackList(recent.items, "recent", recent.startIndex)}`
                    : emptyState("◷", "还没有播放记录", "听几首歌后，最近播放会出现在这里")
                }
              </section>`
            : pane === "local"
              ? `<section class="lib-pane">
                  <div class="lib-pane-actions">
                    <button class="btn ghost sm" id="btn-scan-local" type="button" ${state.localScanning ? "disabled" : ""}>
                      ${state.localScanning ? "扫描中…" : "扫描目录"}
                    </button>
                    ${
                      state.localScanDir
                        ? `<span class="hint">${escapeHtml(state.localScanDir)}</span>`
                        : ""
                    }
                  </div>
                  ${
                    state.localTracks.length
                      ? trackList(state.localTracks, "local")
                      : emptyState(
                          "♫",
                          state.localScanning ? "正在扫描…" : "还没有本地歌曲",
                          state.localScanDir
                            ? "该目录下未找到音频文件"
                            : "扫描下载目录，或把音频放进下载目录后再试",
                        )
                  }
                </section>`
              : `<section class="lib-pane">
              <div class="lib-pane-actions">
                <button class="btn ghost sm" id="btn-new-playlist" type="button">新建歌单</button>
                <button class="btn ghost sm" id="btn-import-playlist" type="button">导入在线歌单</button>
              </div>
              ${
                playlists.length
                  ? playlists
                      .map((p) => {
                        const tracks = p.tracks.map((t) =>
                          storedToTrack(t as LibrarySnapshot["favorites"][number]),
                        );
                        return `
                        <div class="playlist-block">
                          <div class="section-head compact">
                            <h2>${escapeHtml(p.name)} · ${tracks.length}</h2>
                            <div class="section-actions">
                              ${downloadAllButton(`pl-${p.id}`)}
                              <button class="btn ghost sm" data-rename-playlist="${escapeAttr(p.id)}" type="button">重命名</button>
                              <button class="btn ghost sm" data-del-playlist="${escapeAttr(p.id)}" type="button">删除</button>
                            </div>
                          </div>
                          ${
                            tracks.length
                              ? trackList(tracks, `pl-${p.id}`)
                              : emptyState("＋", "空歌单", "在歌曲右侧点 ＋ 即可加入")
                          }
                        </div>`;
                      })
                      .join("")
                  : emptyState("☰", "还没有自建歌单", "点上方「新建歌单」，再在歌曲上点 ＋ 加入")
              }
            </section>`
      }
    </div>
  `;
}

function cacheStatsText(): string {
  const stats = state.cacheStats;
  if (!stats) return "统计中…";
  return `封面 ${stats.coverFiles} 个 / ${formatBytes(stats.coverBytes)} · 播放缓存 ${
    stats.detailsEntries
  } 条`;
}

/** Refresh cache occupancy; the settings card shows the result. */
async function refreshCacheStats() {
  try {
    const next = await invoke<CacheStats>("get_cache_stats");
    state.cacheStats = next;
  } catch {
    state.cacheStats = null;
  }
  const el = document.querySelector("#cache-stats");
  if (el) el.textContent = cacheStatsText();
}

/** Drop backend caches and clear the in-memory cover map so covers reload. */
async function clearCache() {
  try {
    const removed = await invoke<number>("clear_cache");
    coverMemCache.clear();
    await refreshCacheStats();
    toast(`已清理缓存（删除 ${removed} 个封面文件）`);
    renderMain();
  } catch (e) {
    toast(`清理失败：${String(e)}`);
  }
}

/** Ask GitHub for the newest release; also used by the settings card. */
async function checkForUpdate() {
  if (state.checkingUpdate) return;
  state.checkingUpdate = true;
  updateUpdateCard();
  try {
    state.updateInfo = await invoke<UpdateInfo>("check_update");
    if (!state.updateInfo.hasUpdate) toast("已是最新版本");
  } catch (e) {
    state.updateInfo = null;
    toast(`检查更新失败：${String(e)}`);
  } finally {
    state.checkingUpdate = false;
    updateUpdateCard();
  }
}

function updateStatusText(): string {
  const info = state.updateInfo;
  if (state.checkingUpdate) return "正在检查…";
  if (!info) return "尚未检查";
  if (!info.hasUpdate) return `已是最新版本（v${info.current}）`;
  return `发现新版本 v${info.latest}（当前 v${info.current}）`;
}

/** The card is a small isolated block — patch it instead of re-rendering the page. */
function updateUpdateCard() {
  const text = document.querySelector("#update-status");
  if (text) text.textContent = updateStatusText();
  const button = document.querySelector<HTMLButtonElement>("#btn-check-update");
  if (button) {
    button.disabled = state.checkingUpdate;
    button.textContent = state.checkingUpdate ? "检查中…" : "检查更新";
  }
  const download = document.querySelector<HTMLButtonElement>("#btn-update-download");
  if (download) download.hidden = !state.updateInfo?.hasUpdate;
}

async function openUpdatePage() {
  const url = state.updateInfo?.url;
  if (!url) return;
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch (e) {
    toast(`打开下载页失败：${String(e)}`);
  }
}

function renderSettings(): string {
  const enabled = new Set(state.settings.enabledSources);
  const downloadDir =
    state.settings.downloadDir.trim() || state.defaultDownloadDir || "~/Music/猫耳收音机";
  const android = isAndroid();
  return `
    <h1 class="page-title page-title-sm">设置</h1>
    <div class="settings-stack">
      <div class="settings-card about-card">
        <div class="about-logo">
          <img src="${logoUrl}" alt="猫耳收音机" />
          <span class="about-note n1">${ICO.note}</span>
          <span class="about-note n2">${ICO.note}</span>
          <span class="about-note n3">${ICO.note}</span>
        </div>
        <div class="about-meta">
          <h3>猫耳收音机</h3>
          <span class="hint">v${escapeHtml(state.updateInfo?.current ?? "0.2.2")} · 一只爱听歌的猫</span>
        </div>
        <span class="about-eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      </div>
      <div class="settings-card">
        <h3>导入音源</h3>
        <div class="path-row">
          <input class="field-input path-input" id="source-url-input" type="url" placeholder="音源 JSON URL（可覆盖内置）" />
          <button class="btn ghost sm" id="btn-import-source-url" type="button">URL 导入</button>
          <button class="btn ghost sm" id="btn-import-source-file" type="button">本地 JSON</button>
        </div>
      </div>
      <div class="settings-card">
        <h3>启用音源</h3>
        ${
          state.sources.length
            ? `<div class="toggle-list">${state.sources
                .map(
                  (s) => `
          <label class="toggle-row">
            <span>${escapeHtml(s.label)}</span>
            <input type="checkbox" data-source-toggle="${s.id}" ${enabled.has(s.id) ? "checked" : ""} />
          </label>`,
                )
                .join("")}</div>`
            : emptyState("◎", "暂无可用音源", "可在上方导入音源 JSON")
        }
      </div>
      <div class="settings-card settings-inline">
        <h3>播放音质</h3>
        <select class="field-input field-input-sm" id="quality-select">
          ${QUALITY_OPTIONS.map(
            (q) =>
              `<option value="${q.id}" ${(state.settings.quality || "hq") === q.id ? "selected" : ""}>${q.label}</option>`,
          ).join("")}
        </select>
      </div>
      <div class="settings-card settings-inline">
        <h3>每源结果数</h3>
        <input class="field-input field-input-sm" id="limit-input" type="number" min="5" max="30" value="${state.settings.limitPerSource}" />
      </div>
      <div class="settings-card">
        <h3>下载路径</h3>
        <div class="path-row">
          <input class="field-input path-input" id="download-dir-input" type="text" value="${escapeAttr(state.settings.downloadDir)}" placeholder="${escapeAttr(downloadDir)}" ${android ? "readonly" : ""} />
          <button class="btn ghost sm" id="btn-pick-download-dir" type="button">${android ? "选用" : "选择"}</button>
        </div>
        ${
          android
            ? `<p class="settings-hint">手机端无法打开系统文件夹选择器，请从应用可用目录中选用。</p>`
            : ""
        }
      </div>
      <div class="settings-card settings-inline">
        <h3>主题</h3>
        <button class="btn ghost sm" id="btn-theme-toggle" type="button" aria-pressed="${
          state.theme === "light"
        }">${state.theme === "light" ? "浅色" : "深色"}</button>
      </div>
      ${
        isAndroid()
          ? ""
          : `<div class="settings-card settings-inline">
        <h3>桌面歌词</h3>
        <button class="btn ghost sm" id="btn-desktop-lyrics" type="button" aria-pressed="${
          state.desktopLyrics.visible
        }">${state.desktopLyrics.visible ? "已开启" : "关闭"}</button>
        ${
          state.desktopLyrics.visible && state.desktopLyrics.locked
            ? `<button class="btn ghost sm" id="btn-desktop-unlock" type="button">解除锁定</button>`
            : ""
        }
        ${
          state.desktopLyrics.visible
            ? `<span class="hint">拖动窗口移动位置 · 点「锁」切换鼠标穿透</span>`
            : ""
        }
      </div>`
      }
      <div class="settings-card settings-inline">
        <h3>缓存占用</h3>
        <span class="hint" id="cache-stats">${escapeHtml(cacheStatsText())}</span>
        <button class="btn ghost sm" id="btn-clear-cache" type="button">清理缓存</button>
      </div>
      ${eqPanelHtml()}
      <div class="settings-card">
        <h3>版本更新</h3>
        <span class="hint" id="update-status">${escapeHtml(updateStatusText())}</span>
        <div class="path-row">
          <button class="btn ghost sm" id="btn-check-update" type="button" ${
            state.checkingUpdate ? "disabled" : ""
          }>${state.checkingUpdate ? "检查中…" : "检查更新"}</button>
          <button class="btn ghost sm" id="btn-update-download" type="button" ${
            state.updateInfo?.hasUpdate ? "" : "hidden"
          }>前往下载</button>
        </div>
      </div>
      <button class="btn sm" id="btn-save-settings">保存设置</button>
    </div>
  `;
}

function modeLabel(): string {
  return state.playMode === "list"
    ? "列表循环"
    : state.playMode === "single"
      ? "单曲循环"
      : "随机播放";
}

function modeLabelShort(): string {
  return state.playMode === "list" ? "列表" : state.playMode === "single" ? "单曲" : "随机";
}

function renderLyricsPanel(): string {
  const t = state.current;
  if (!t) {
    return `
      <div class="lp-head">
        <h3>歌词</h3>
        <button class="icon-btn" id="btn-close-lyrics" type="button" title="关闭">✕</button>
      </div>
      ${emptyState("♩", "还没有在播放", "选一首歌后，歌词会出现在这里")}
    `;
  }

  const activeIdx = activeLyricIndex(state.position);
  const lyricHtml = state.lyrics.length
    ? state.lyrics
        .map((line, idx) => {
          const active = idx === activeIdx;
          const text = escapeHtml(line.text || " ");
          const body = line.words?.length
            ? `<span class="lyric-text karaoke" data-karaoke="${idx}">${line.words
                .map((w, i) => `<span class="kw" data-i="${i}">${escapeHtml(w.text)}</span>`)
                .join("")}</span>`
            : `<span class="lyric-text">${text}</span>`;
          const translation =
            state.lyricTranslation && line.translation
              ? `<span class="lyric-tr">${escapeHtml(line.translation)}</span>`
              : "";
          return `<button type="button" class="lyric-line${active ? " active-line" : ""}" data-lyric-idx="${idx}" title="跳到这句">${body}${translation}</button>`;
        })
        .join("")
    : emptyState("¶", "暂无歌词", "这首歌没有附带 LRC");

  return `
    <div class="lp-head">
      <h3>${state.preparing ? "准备中…" : "歌词"}</h3>
      <button class="icon-btn" id="btn-close-lyrics" type="button" title="关闭">✕</button>
    </div>
    <img class="cover lg" src="${coverPlaceholder()}"${coverAttrs(t, "full")} alt="" decoding="async" />
    <h2 class="np-title">${escapeHtml(t.title)}</h2>
    <p class="np-artist">${escapeHtml(t.artist)} · ${SOURCE_LABEL[t.source] || t.source}</p>
    <div class="lp-tools" role="toolbar" aria-label="歌词设置">
      <button class="btn ghost sm" type="button" id="btn-lyric-font-down" title="缩小歌词">A−</button>
      <button class="btn ghost sm" type="button" id="btn-lyric-font-up" title="放大歌词">A+</button>
      <button class="btn ghost sm" type="button" id="btn-lyric-tr" aria-pressed="${state.lyricTranslation}" title="显示/隐藏译文">译</button>
      <span class="lp-tools-sep" aria-hidden="true"></span>
      <button class="btn ghost sm" type="button" id="btn-lyric-offset-down" title="歌词提前 0.5 秒">−0.5</button>
      <span class="lp-offset" id="lyric-offset-label" title="本曲歌词时间偏移">${formatLyricOffset(currentLyricOffset())}</span>
      <button class="btn ghost sm" type="button" id="btn-lyric-offset-up" title="歌词延后 0.5 秒">+0.5</button>
    </div>
    <div class="lyrics" data-size="${state.lyricFont}">${lyricHtml}</div>
    <div class="lp-foot">
      <button class="btn ghost sm" id="btn-fav-np" type="button">${isFavorite(t.uid) ? "已收藏" : "收藏"}</button>
    </div>
  `;
}

function renderPageHtml(): string {
  return state.tab === "discover"
    ? renderDiscover()
    : state.tab === "library"
      ? renderLibrary()
      : renderSettings();
}

function renderTopbarHtml(): string {
  return `
    <div class="topbar">
      ${
        state.searchTracks.length || state.browsePlaylistId || state.detail
          ? `<button class="back-btn" id="btn-clear-search" type="button" title="返回发现" aria-label="返回发现">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6"/>
              </svg>
            </button>`
          : ""
      }
      <div class="search-row">
        <div class="search-field">
          <input id="search-input" placeholder="搜索歌曲、歌手、拼音首字母" value="${escapeAttr(state.keyword)}" autocomplete="off" />
          <div id="search-suggest">${state.searchHistoryOpen ? searchSuggestHtml() : ""}</div>
        </div>
        <button class="btn sm" id="btn-search" ${state.searching ? "disabled" : ""}>${
          state.searching ? "搜索中…" : "搜索"
        }</button>
      </div>
      <div class="topbar-actions">
        <button class="mode-btn" id="btn-theme-quick" type="button" title="切换主题" aria-label="切换主题">${
          state.theme === "light" ? "☾" : "☀"
        }</button>
      </div>
    </div>`;
}

function renderMainColumnHtml(): string {
  return `${renderTopbarHtml()}<div class="page-scroll">${renderPageHtml()}</div>`;
}

/** Update nav + main only — keep lyrics/player DOM so the panel does not flash. */
function renderMain() {
  const main = app.querySelector(".main");
  if (!main) {
    render();
    return;
  }
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === state.tab);
  });
  main.innerHTML = renderMainColumnHtml();
  bindMainEvents();
  hydrateCovers();
  afterRenderMotion();
}

function renderPlayerDockHtml(): string {
  const current = state.current;
  const showLyrics = state.lyricsOpen;
  return `
      <footer class="player-dock${state.playing ? " is-playing" : ""}">
        ${
          current
            ? `<button class="player-now" type="button" id="toggle-lyrics" title="查看歌词">
                <span class="dock-cover-wrap">
                  <img class="cover" src="${coverPlaceholder()}"${coverAttrs(current, "full")} alt="" decoding="async" />
                  <span class="cover-eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
                </span>
                <div class="meta">
                  <div class="title">${escapeHtml(current.title)}</div>
                  <div class="sub">${
                    current.artist
                      ? `<span class="artist-link" data-artist="${escapeAttr(current.artist)}" title="查看歌手">${escapeHtml(
                          current.artist,
                        )}</span>`
                      : "未知歌手"
                  }${state.preparing ? " · 准备中" : ""}</div>
                </div>
                ${favButton(current.uid)}
              </button>`
            : `<div class="player-now">
                <img class="cover" src="${coverPlaceholder()}" alt="" style="opacity:.5" />
                <div class="meta"><div class="title">未在播放</div><div class="sub">从列表选一首歌</div></div>
              </div>`
        }
        <div class="player-controls">
          <div class="btns">
            <button class="icon-btn" id="btn-prev" type="button" title="上一首">${ICO.prev}</button>
            <button class="icon-btn primary" id="btn-pp" type="button" title="播放/暂停">${
              state.preparing ? ICO.spinner : state.playing ? ICO.pause : ICO.play
            }</button>
            <button class="icon-btn" id="btn-next" type="button" title="下一首">${ICO.next}</button>
          </div>
        </div>
        <div class="time-row">
          <span id="time-cur">${formatTime(state.position)}</span>
          <input class="seek" id="seek" type="range" min="0" max="${Math.max(1, state.duration)}" step="0.1" value="${state.position}" />
          <span id="time-dur">${formatTime(state.duration)}</span>
        </div>
        <div class="player-extra">
          <div class="volume-row" title="音量">
            <button class="icon-btn volume-mute" id="btn-mute" type="button" title="${
              state.muted || state.volume <= 0.001 ? "取消静音" : "静音"
            }">${volumeIconSvg(state.volume, state.muted)}</button>
            <input
              class="volume"
              id="volume"
              type="range"
              min="0"
              max="1"
              step="0.01"
              value="${state.muted ? 0 : state.volume}"
              aria-label="音量"
            />
          </div>
          <button class="mode-btn" id="btn-mode-bar" type="button" title="${modeLabel()}">${modeLabelShort()}</button>
          <button class="mode-btn${state.playRate !== 1 ? " is-active" : ""}" id="btn-rate" type="button" title="播放速度">${playRateLabel(
            state.playRate,
          )}</button>
          <button class="mode-btn${state.queueOpen ? " is-active" : ""}" id="btn-queue" type="button" title="播放队列">队列${
            state.queue.length ? ` · ${state.queue.length}` : ""
          }</button>
          <button class="mode-btn${state.sleep ? " is-active" : ""}" id="btn-sleep" type="button" title="${
            state.sleep ? "定时关闭中 · 点击调整" : "定时关闭"
          }">${sleepLabel()}</button>
          <span class="mode-btn dl-queue${downloadQueueLabel() ? " is-active" : ""}" id="dl-queue" title="下载队列">${
            downloadQueueLabel() || "下载"
          }</span>
          <button class="mode-btn" id="toggle-lyrics-2" type="button">${showLyrics ? "收起" : "歌词"}</button>
        </div>
      </footer>`;
}

function render() {
  const showLyrics = state.lyricsOpen;

  app.innerHTML = `
    <div class="wallpaper" aria-hidden="true"></div>
    <div class="app-shell ${showLyrics ? "lyrics-open" : ""}">
      <aside class="sidebar">
        <div class="brand-block">
          <img class="brand-mark" src="${logoUrl}" alt="" width="36" height="36" />
          <div class="brand-text">
            <h1 class="brand">猫耳收音机</h1>
          </div>
        </div>
        <nav class="nav">
          <button data-tab="discover" class="${state.tab === "discover" ? "active" : ""}" type="button">
            <span class="nav-ico ico-discover">${ICO.discover}</span><span class="label">发现</span>
          </button>
          <button data-tab="library" class="${state.tab === "library" ? "active" : ""}" type="button">
            <span class="nav-ico ico-heart">${ICO.heart}</span><span class="label">我的</span>
          </button>
          <button data-tab="settings" class="${state.tab === "settings" ? "active" : ""}" type="button">
            <span class="nav-ico ico-gear">${ICO.gear}</span><span class="label">设置</span>
          </button>
        </nav>
      </aside>

      <main class="main">${renderMainColumnHtml()}</main>

      <aside class="lyrics-panel">${renderLyricsPanel()}</aside>

      ${renderPlayerDockHtml()}
    </div>
    <div id="overlay-root">${renderDialog()}${renderContextMenu()}</div>
    <div id="queue-root">${renderQueueDrawer()}</div>
    <div class="toast ${state.toast ? "" : "hidden"}">${escapeHtml(state.toast)}</div>
  `;

  bindEvents();
  hydrateCovers();
  afterRenderMotion();
}

/** Repaint the player dock in place — the search/library lists stay untouched. */
function patchPlayerDock() {
  const dock = app.querySelector<HTMLElement>(".player-dock");
  if (!dock) {
    render();
    return;
  }
  dock.outerHTML = renderPlayerDockHtml();
  bindPlayerEvents();
  hydrateCovers();
}

/** Repaint the lyrics panel in place (only exists while lyrics are open). */
function patchLyricsPanel() {
  const panel = app.querySelector<HTMLElement>(".lyrics-panel");
  if (!panel) {
    render();
    return;
  }
  panel.innerHTML = renderLyricsPanel();
  bindLyricsEvents();
  hydrateCovers();
  lastLyricScrollIdx = -1;
  syncLyricsHighlight({ forceScroll: true });
}

/** Re-apply row highlight / playing marker without rebuilding the row HTML. */
function patchTrackRowActive() {
  const uid = state.current?.uid || "";
  document.querySelectorAll<HTMLElement>("[data-play-uid]").forEach((row) => {
    const active = row.dataset.playUid === uid;
    row.classList.toggle("active", active);
    const idx = row.querySelector<HTMLElement>(":scope > .idx");
    if (!idx) return;
    idx.textContent = active && state.playing ? "♪" : idx.dataset.idx || "";
  });
}

/** Dialog + context menu live in their own root so overlays never reset list scroll. */
function patchOverlays() {
  const root = app.querySelector<HTMLElement>("#overlay-root");
  if (!root) {
    render();
    return;
  }
  root.innerHTML = `${renderDialog()}${renderContextMenu()}`;
  bindOverlayEvents();
}

/**
 * Cheap playback refresh: dock, lyrics, active row, queue drawer.
 * Replaces the full `render()` on track switches and download ticks.
 */
function patchPlaybackViews() {
  patchTrackRowActive();
  patchPlayerDock();
  if (state.lyricsOpen) patchLyricsPanel();
  patchQueueBtn();
  if (state.queueOpen) syncQueueDrawer();
  afterRenderMotion();
}

function afterRenderMotion() {
  const reduce =
    typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    lastMotionTab = state.tab;
    lastMotionTrackUid = state.current?.uid || "";
    lastMotionLyricsOpen = state.lyricsOpen;
    if (state.lyricsOpen && state.lyrics.length) {
      lastLyricScrollIdx = -1;
      requestAnimationFrame(() => syncLyricsHighlight({ forceScroll: true }));
    }
    return;
  }

  const tabChanged = lastMotionTab !== "" && lastMotionTab !== state.tab;
  const trackChanged =
    lastMotionTrackUid !== "" && lastMotionTrackUid !== (state.current?.uid || "");
  const lyricsJustOpened =
    lastMotionLyricsOpen === false && state.lyricsOpen === true;

  if (tabChanged) {
    const page = document.querySelector(".page-scroll");
    page?.classList.remove("page-enter");
    void (page as HTMLElement | null)?.offsetWidth;
    page?.classList.add("page-enter");
    const tabBtn = document.querySelector<HTMLElement>(`.nav button.active`);
    if (tabBtn) {
      tabBtn.classList.remove("soft-pop");
      void tabBtn.offsetWidth;
      tabBtn.classList.add("soft-pop");
    }
  }

  if (trackChanged) {
    document
      .querySelectorAll(".player-now .cover, .lyrics-panel .cover.lg")
      .forEach((el) => {
        el.classList.remove("cover-swap");
        void (el as HTMLElement).offsetWidth;
        el.classList.add("cover-swap");
      });
    document
      .querySelectorAll(".player-now .meta, .lyrics-panel .np-title, .lyrics-panel .np-artist")
      .forEach((el) => {
        el.classList.remove("meta-swap");
        void (el as HTMLElement).offsetWidth;
        el.classList.add("meta-swap");
      });
    const pp = document.querySelector("#btn-pp");
    pp?.classList.remove("pp-pop");
    void (pp as HTMLElement | null)?.offsetWidth;
    pp?.classList.add("pp-pop");
    const row = document.querySelector<HTMLElement>(".track-row.active");
    if (row) {
      row.classList.remove("soft-pop");
      void row.offsetWidth;
      row.classList.add("soft-pop");
    }
  }

  // Lyrics panel already gets CSS animation via .lyrics-open; re-trigger if needed.
  if (lyricsJustOpened) {
    const panel = document.querySelector(".lyrics-panel");
    if (panel) {
      panel.classList.remove("lyrics-enter");
      void (panel as HTMLElement).offsetWidth;
      panel.classList.add("lyrics-enter");
    }
  }

  lastMotionTab = state.tab;
  lastMotionTrackUid = state.current?.uid || "";
  lastMotionLyricsOpen = state.lyricsOpen;

  // Full DOM rebuild resets scrollTop — snap back to the singing line.
  if (state.lyricsOpen && state.lyrics.length) {
    if (trackChanged || lyricsJustOpened) lastLyricScrollIdx = -1;
    requestAnimationFrame(() => syncLyricsHighlight({ forceScroll: true }));
  }
}

function queueKeyFor(el: Element | null): string {
  const root = el?.closest("[data-queue]") as HTMLElement | null;
  return root?.dataset.queue || "";
}

function queueFor(el: Element | null): Track[] {
  const key = queueKeyFor(el);
  return key ? queueFromKey(key) : state.queue.length ? state.queue : state.current ? [state.current] : [];
}

function queueKindFor(key: string): null | "search" {
  return key === "search" ? "search" : null;
}

function bindEvents() {
  bindChromeEvents();
  bindMainEvents();
  bindOverlayEvents();
  bindQueueEvents();
}

function patchQueueBtn() {
  const btn = document.querySelector("#btn-queue");
  if (!btn) return;
  btn.textContent = `队列${state.queue.length ? ` · ${state.queue.length}` : ""}`;
  btn.classList.toggle("is-active", state.queueOpen);
}

function bindQueueEvents() {
  document.querySelector("#queue-backdrop")?.addEventListener("click", () => toggleQueueDrawer(false));
  document.querySelector("#btn-queue-close")?.addEventListener("click", () => toggleQueueDrawer(false));
  document.querySelector("#btn-queue-clear")?.addEventListener("click", () => clearQueue());
  document.querySelectorAll<HTMLElement>("[data-queue-jump]").forEach((row) => {
    const jump = () => {
      const idx = Number(row.dataset.queueJump);
      if (Number.isFinite(idx)) playQueueIndex(idx);
    };
    row.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("[data-queue-remove]")) return;
      jump();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        jump();
      }
    });
  });
  document.querySelectorAll<HTMLElement>("[data-queue-remove]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const uid = btn.dataset.queueRemove;
      if (uid) removeQueueTrack(uid);
    });
  });
  patchQueueBtn();
}

function bindSidebarEvents() {
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab as TabId;
      renderMain();
      if (state.tab === "settings") void refreshCacheStats();
    });
  });
}

/** Player dock listeners — rebound whenever the dock HTML is replaced. */
function bindPlayerEvents() {
  document.querySelector("#btn-pp")?.addEventListener("click", () => playPause());
  document.querySelector("#btn-prev")?.addEventListener("click", () => skip(-1));
  document.querySelector("#btn-next")?.addEventListener("click", () => skip(1));
  document.querySelector("#btn-mode-bar")?.addEventListener("click", () => cyclePlayMode());
  document.querySelector("#btn-rate")?.addEventListener("click", () => cyclePlayRate());
  document.querySelector("#btn-queue")?.addEventListener("click", () => toggleQueueDrawer());
  document.querySelector("#btn-sleep")?.addEventListener("click", () => openSleepTimerDialog());
  document.querySelector("#toggle-lyrics-2")?.addEventListener("click", () => toggleLyrics());

  const playerNow = document.querySelector("#toggle-lyrics");
  playerNow?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-artist]")) {
      e.preventDefault();
      e.stopPropagation();
      const el = target.closest("[data-artist]") as HTMLElement;
      openDetail("artist", el.dataset.artist || "");
      return;
    }
    if (target.closest("[data-fav-uid]")) {
      e.preventDefault();
      e.stopPropagation();
      const fav = target.closest("[data-fav-uid]") as HTMLElement;
      const track = findTrack(fav.dataset.favUid!) || state.current;
      if (track) void toggleFavorite(track);
      return;
    }
    toggleLyrics();
  });

  const seek = document.querySelector<HTMLInputElement>("#seek");
  seek?.addEventListener("input", () => {
    lyricsUserScrollUntil = 0;
    lastLyricScrollIdx = -1;
    seekTo(Number(seek.value));
    syncLyricsHighlight({ forceScroll: true });
  });

  document.querySelector("#btn-mute")?.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleMute();
  });
  const volume = document.querySelector<HTMLInputElement>("#volume");
  volume?.addEventListener("input", () => {
    state.muted = false;
    applyVolume(Number(volume.value));
  });
}

/** Lyrics panel listeners — rebound whenever the panel HTML is replaced. */
function bindLyricsEvents() {
  document.querySelector("#btn-fav-np")?.addEventListener("click", () => {
    if (state.current) void toggleFavorite(state.current);
  });
  document.querySelector("#btn-close-lyrics")?.addEventListener("click", () => toggleLyrics(false));
  document.querySelector("#btn-lyric-font-down")?.addEventListener("click", () => cycleLyricFont(-1));
  document.querySelector("#btn-lyric-font-up")?.addEventListener("click", () => cycleLyricFont(1));
  document.querySelector("#btn-lyric-tr")?.addEventListener("click", () => toggleLyricTranslation());
  document.querySelector("#btn-lyric-offset-down")?.addEventListener("click", () => nudgeLyricOffset(-0.5));
  document.querySelector("#btn-lyric-offset-up")?.addEventListener("click", () => nudgeLyricOffset(0.5));
  document.querySelectorAll<HTMLElement>("[data-lyric-idx]").forEach((el) => {
    el.addEventListener("click", () => {
      const idx = Number(el.dataset.lyricIdx);
      const line = state.lyrics[idx];
      if (!line) return;
      lyricsUserScrollUntil = 0;
      lastLyricScrollIdx = -1;
      seekTo(line.time);
      syncLyricsHighlight({ forceScroll: true });
    });
  });
}

function bindChromeEvents() {
  bindSidebarEvents();
  bindPlayerEvents();
  bindLyricsEvents();
}

function bindMainEvents() {
  document.querySelectorAll<HTMLButtonElement>("[data-lib-pane]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.libraryPane = btn.dataset.libPane as
        | "favorites"
        | "recent"
        | "playlists"
        | "local";
      renderMain();
    });
  });
  document.querySelector("#btn-scan-local")?.addEventListener("click", () => void scanLocalTracks());
  document.querySelector("#btn-clear-recent")?.addEventListener("click", () => {
    state.recent = [];
    state.recentPage = 1;
    persistRecent([]);
    toast("已清空最近播放");
    renderMain();
  });

  const searchInput = document.querySelector<HTMLInputElement>("#search-input");
  searchInput?.addEventListener("input", () => {
    state.keyword = searchInput.value;
    // Typing turns the dropdown into instant local matches; patch in place so
    // the caret does not jump.
    if (!state.searchHistoryOpen) {
      state.searchHistoryOpen = true;
      attachSearchHistoryDocHandler();
    }
    patchSearchSuggest();
  });
  searchInput?.addEventListener("focus", () => {
    // The dropdown is worth opening even with no history — it now also
    // carries hot keywords.
    if (state.searchHistoryOpen) return;
    state.searchHistoryOpen = true;
    attachSearchHistoryDocHandler();
    patchSearchSuggest();
  });
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doSearch(true);
    if (e.key === "Escape" && state.searchHistoryOpen) {
      state.searchHistoryOpen = false;
      detachSearchHistoryDocHandler();
      patchSearchSuggest();
    }
  });
  if (state.searchHistoryOpen) {
    attachSearchHistoryDocHandler();
    bindSearchSuggestEvents();
  } else {
    detachSearchHistoryDocHandler();
  }
  document.querySelector("#btn-search")?.addEventListener("click", () => void doSearch(true));
  document.querySelector("#btn-detail-search")?.addEventListener("click", () => searchDetailName());
  document.querySelector("#btn-theme-quick")?.addEventListener("click", () => toggleTheme());
  document.querySelector("#btn-clear-search")?.addEventListener("click", () => clearSearch());
  document.querySelector("#btn-search-prev")?.addEventListener("click", () => void goSearchPage(-1));
  document.querySelector("#btn-search-next")?.addEventListener("click", () => void goSearchPage(1));
  document.querySelectorAll<HTMLElement>("[data-pager]").forEach((pager) => {
    const key = pager.dataset.pager || "";
    pager.querySelectorAll<HTMLButtonElement>("[data-page-delta]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const delta = Number(btn.dataset.pageDelta || 0);
        if (!delta || !key) return;
        goLocalListPage(key, delta);
      });
    });
  });
  document.querySelector("#btn-refresh-rec")?.addEventListener("click", () => void refreshRecommend(true));

  document.querySelectorAll<HTMLElement>("[data-play-uid]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (state.contextMenu) {
        closeContextMenu();
        return;
      }
      const target = e.target as HTMLElement;
      if (target.closest("[data-artist]")) {
        e.preventDefault();
        e.stopPropagation();
        const el = target.closest("[data-artist]") as HTMLElement;
        openDetail("artist", el.dataset.artist || "");
        return;
      }
      if (target.closest("[data-album]")) {
        e.preventDefault();
        e.stopPropagation();
        const el = target.closest("[data-album]") as HTMLElement;
        openDetail("album", el.dataset.album || "", el.dataset.albumArtist || "");
        return;
      }
      if (target.closest("[data-group-toggle]")) {
        e.preventDefault();
        e.stopPropagation();
        const el = target.closest("[data-group-toggle]") as HTMLElement;
        const key = el.dataset.groupToggle || "";
        if (state.searchGroupOpen.has(key)) state.searchGroupOpen.delete(key);
        else state.searchGroupOpen.add(key);
        renderMain();
        return;
      }
      if (target.closest("[data-fav-uid]")) {
        e.preventDefault();
        e.stopPropagation();
        const fav = target.closest("[data-fav-uid]") as HTMLElement;
        const track = findTrack(fav.dataset.favUid!);
        if (track) void toggleFavorite(track);
        return;
      }
      if (target.closest("[data-add-pl-uid]")) {
        e.preventDefault();
        e.stopPropagation();
        const el = target.closest("[data-add-pl-uid]") as HTMLElement;
        openAddToPlaylistDialog(el.dataset.addPlUid!);
        return;
      }
      if (target.closest("[data-pl-remove-uid]")) {
        e.preventDefault();
        e.stopPropagation();
        const el = target.closest("[data-pl-remove-uid]") as HTMLElement;
        const playlistId = el.dataset.plId || "";
        const trackUid = el.dataset.plRemoveUid || "";
        if (playlistId && trackUid) void removeTrackFromPlaylist(playlistId, trackUid);
        return;
      }
      if (target.closest("[data-pl-move]")) {
        e.preventDefault();
        e.stopPropagation();
        const el = target.closest("[data-pl-move]") as HTMLElement;
        if (el.classList.contains("is-disabled") || el.getAttribute("aria-disabled") === "true") {
          return;
        }
        const playlistId = el.dataset.plId || "";
        const fromIndex = Number(el.dataset.plIndex);
        const dir = el.dataset.plMove;
        if (!playlistId || !Number.isFinite(fromIndex) || (dir !== "up" && dir !== "down")) return;
        const toIndex = dir === "up" ? fromIndex - 1 : fromIndex + 1;
        void movePlaylistTrack(playlistId, fromIndex, toIndex);
        return;
      }
      if (target.closest("[data-dl-uid]")) {
        e.preventDefault();
        e.stopPropagation();
        const dl = target.closest("[data-dl-uid]") as HTMLElement;
        const track = findTrack(dl.dataset.dlUid!);
        if (track) void downloadTrack(track);
        return;
      }
      const uid = row.dataset.playUid!;
      const track = findTrack(uid);
      if (track) {
        const key = queueKeyFor(row);
        void playTrack(track, queueFor(row), queueKindFor(key));
      }
    });
    row.addEventListener("contextmenu", (e) => {
      openTrackContextMenu(e, row.dataset.playUid!, queueKeyFor(row));
    });
  });

  document.querySelectorAll<HTMLElement>("[data-playlist-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pl = state.recommend?.hotPlaylists.find((p) => p.id === btn.dataset.playlistId);
      if (pl?.tracks?.length) openRecommendPlaylist(pl);
    });
  });

  document.querySelectorAll<HTMLElement>("[data-dl-all]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.dlAll || "";
      const tracks = tracksForDownloadKey(key);
      if (!tracks.length) {
        toast("当前列表没有可下载的歌曲");
        return;
      }
      downloadTracks(tracks);
    });
  });

  document.querySelector("#btn-new-playlist")?.addEventListener("click", () => openNewPlaylistDialog());
  document.querySelector("#btn-import-playlist")?.addEventListener("click", () => {
    openImportPlaylistDialog();
  });
  document.querySelector("#btn-export-library")?.addEventListener("click", () => {
    void exportLibraryBackup();
  });
  document.querySelector("#btn-import-library")?.addEventListener("click", () => {
    void pickLibraryImport();
  });
  document.querySelectorAll<HTMLElement>("[data-rename-playlist]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.renamePlaylist!;
      const name = state.library?.playlists.find((p) => p.id === id)?.name || "歌单";
      openRenamePlaylistDialog(id, name);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-del-playlist]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.delPlaylist!;
      const name = state.library?.playlists.find((p) => p.id === id)?.name || "歌单";
      openDeletePlaylistDialog(id, name);
    });
  });

  document.querySelector("#btn-pick-download-dir")?.addEventListener("click", () => {
    void pickDownloadDir();
  });
  document.querySelector("#btn-import-source-url")?.addEventListener("click", () => {
    void importSourceFromUrl();
  });
  document.querySelector("#source-url-input")?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") void importSourceFromUrl();
  });
  document.querySelector("#btn-import-source-file")?.addEventListener("click", () => {
    void importSourceFromFile();
  });

  document.querySelector("#btn-clear-cache")?.addEventListener("click", () => void clearCache());
  document.querySelector("#btn-eq-toggle")?.addEventListener("click", () => void toggleEq());
  document.querySelectorAll<HTMLElement>("[data-eq-preset]").forEach((btn) => {
    btn.addEventListener("click", () => applyEqPreset(btn.dataset.eqPreset || "flat"));
  });
  document.querySelectorAll<HTMLInputElement>("[data-eq-band]").forEach((slider) => {
    slider.addEventListener("input", () => {
      setEqBand(Number(slider.dataset.eqBand), Number(slider.value));
    });
  });
  document.querySelector("#eq-preamp")?.addEventListener("input", (e) => {
    setEqPreampValue(Number((e.target as HTMLInputElement).value));
  });
  document.querySelector("#btn-check-update")?.addEventListener("click", () => void checkForUpdate());
  document
    .querySelector("#btn-update-download")
    ?.addEventListener("click", () => void openUpdatePage());
  document.querySelector("#btn-theme-toggle")?.addEventListener("click", () => toggleTheme());
  document
    .querySelector("#btn-desktop-lyrics")
    ?.addEventListener("click", () => toggleDesktopLyrics());
  document
    .querySelector("#btn-desktop-unlock")
    ?.addEventListener("click", () => void unlockDesktopLyrics());
  document.querySelector("#btn-save-settings")?.addEventListener("click", () => {
    const enabled = Array.from(
      document.querySelectorAll<HTMLInputElement>("[data-source-toggle]:checked"),
    ).map((el) => el.dataset.sourceToggle as AppSettings["enabledSources"][number]);
    const limit = Number(
      (document.querySelector("#limit-input") as HTMLInputElement | null)?.value || 10,
    );
    const downloadDir =
      (document.querySelector("#download-dir-input") as HTMLInputElement | null)?.value.trim() ||
      "";
    const quality =
      (document.querySelector("#quality-select") as HTMLSelectElement | null)?.value || "hq";
    void saveSettings({
      ...state.settings,
      enabledSources: enabled,
      limitPerSource: Math.min(30, Math.max(5, limit || 10)),
      downloadDir,
      quality,
    });
  });
}

function bindOverlayEvents() {
  const ctxMenu = document.querySelector<HTMLElement>("#ctx-menu");
  if (ctxMenu && state.contextMenu) {
    const rect = ctxMenu.getBoundingClientRect();
    let { x, y } = state.contextMenu;
    if (x + rect.width > window.innerWidth - 8) x = Math.max(8, window.innerWidth - rect.width - 8);
    if (y + rect.height > window.innerHeight - 8) y = Math.max(8, window.innerHeight - rect.height - 8);
    ctxMenu.style.left = `${x}px`;
    ctxMenu.style.top = `${y}px`;
  }
  document.querySelector("#ctx-backdrop")?.addEventListener("mousedown", () => closeContextMenu());
  document.querySelectorAll<HTMLElement>("[data-ctx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const menu = state.contextMenu;
      if (!menu) return;
      const track = findTrack(menu.trackUid);
      const action = btn.dataset.ctx;
      state.contextMenu = null;
      if (!track || !action) {
        patchOverlays();
        return;
      }
      if (action === "play") {
        void playTrack(track, queueFromKey(menu.queueKey), queueKindFor(menu.queueKey));
        patchOverlays();
        return;
      }
      if (action === "add-pl") {
        patchOverlays();
        openAddToPlaylistDialog(track.uid);
        return;
      }
      if (action === "remove-pl") {
        const playlistId = menu.queueKey.startsWith("pl-") ? menu.queueKey.slice(3) : "";
        if (playlistId) {
          void removeTrackFromPlaylist(playlistId, track.uid);
          return;
        }
        patchOverlays();
        return;
      }
      if (action === "fav") {
        void toggleFavorite(track);
        return;
      }
      if (action === "download") {
        void downloadTrack(track);
        patchOverlays();
        return;
      }
      patchOverlays();
    });
  });

  const dialogInput = document.querySelector<HTMLInputElement>("#dialog-input");
  document.querySelector("#dialog-cancel")?.addEventListener("click", () => closeDialog());
  document.querySelector("#dialog-backdrop")?.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeDialog();
  });
  document.querySelector("#dialog-ok")?.addEventListener("click", () => {
    const d = state.dialog;
    if (!d) return;
    if (d.kind === "new-playlist") {
      void submitNewPlaylist(dialogInput?.value || "");
    } else if (d.kind === "import-playlist") {
      void submitImportPlaylist(dialogInput?.value || "");
    } else if (d.kind === "rename-playlist") {
      void submitRenamePlaylist(d.id, dialogInput?.value || "");
    } else if (d.kind === "delete-playlist") {
      void confirmDeletePlaylist(d.id);
    } else if (d.kind === "import-library") {
      void confirmImportLibrary(d.path);
    }
  });
  document.querySelectorAll<HTMLElement>("[data-pick-playlist]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const d = state.dialog;
      if (d?.kind !== "add-to-playlist") return;
      void addTrackToPlaylist(btn.dataset.pickPlaylist!, d.trackUid);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-pick-download-dir]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = btn.dataset.pickDownloadDir || "";
      if (!path) return;
      void applyDownloadDirPreset(path);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-sleep]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.dataset.sleep || "";
      if (v === "off") {
        clearSleepTimer();
        state.dialog = null;
        patchOverlays();
        return;
      }
      if (v === "track") {
        setSleepAfterTrack();
        return;
      }
      const mins = Number(v);
      if (Number.isFinite(mins) && mins > 0) setSleepMinutes(mins);
    });
  });
  dialogInput?.addEventListener("keydown", (e) => {
    const d = state.dialog;
    if (e.key === "Enter") {
      if (d?.kind === "rename-playlist") void submitRenamePlaylist(d.id, dialogInput.value);
      else if (d?.kind === "new-playlist") void submitNewPlaylist(dialogInput.value);
      else if (d?.kind === "import-playlist") void submitImportPlaylist(dialogInput.value);
    }
    if (e.key === "Escape") closeDialog();
  });
  if (dialogInput) {
    dialogInput.focus();
    dialogInput.select();
  }
}

/** Whether the loaded lyrics carry word timings — decided once per track. */
let lyricHasWords = false;

/** Last lyric index we scrolled to — avoid smooth-scroll spam on every timeupdate. */
let lastLyricScrollIdx = -1;
/** Ignore auto-scroll briefly after the user manually scrolls the lyrics pane. */
let lyricsUserScrollUntil = 0;

function activeLyricIndex(position: number): number {
  if (!state.lyrics.length) return -1;
  // Positive offset = lyrics feel late → compare against an earlier clock.
  const t = position - currentLyricOffset();
  for (let i = 0; i < state.lyrics.length; i++) {
    const next = state.lyrics[i + 1];
    if (t >= state.lyrics[i].time && (!next || t < next.time)) return i;
  }
  if (t < state.lyrics[0].time) return -1;
  return state.lyrics.length - 1;
}

function bindLyricsScrollGuard(container: Element) {
  if ((container as HTMLElement).dataset.scrollGuard === "1") return;
  (container as HTMLElement).dataset.scrollGuard = "1";
  container.addEventListener(
    "wheel",
    () => {
      lyricsUserScrollUntil = Date.now() + 4000;
    },
    { passive: true },
  );
  container.addEventListener(
    "touchmove",
    () => {
      lyricsUserScrollUntil = Date.now() + 4000;
    },
    { passive: true },
  );
}

/**
 * Karaoke fill for word-timed lines: sung words are fully opaque, the word
 * currently being sung fades in proportionally to its elapsed share.
 */
function paintKaraoke(lyrics: Element, activeIdx: number, position = state.position) {
  const line = state.lyrics[activeIdx];
  if (!line?.words?.length) return;
  const host = lyrics.querySelector<HTMLElement>(`[data-karaoke="${activeIdx}"]`);
  if (!host) return;
  const at = position - currentLyricOffset();
  const spans = host.querySelectorAll<HTMLElement>(".kw");
  spans.forEach((span, i) => {
    const word = line.words?.[i];
    if (!word) return;
    const progress = at <= word.time ? 0 : at >= word.end ? 1 : (at - word.time) / (word.end - word.time);
    span.classList.toggle("sung", progress >= 1);
    // Only the word in flight needs a numeric value.
    const style = span.style;
    style.opacity = progress > 0 && progress < 1 ? String(0.3 + 0.7 * progress) : "";
  });
}

function syncLyricsHighlight(opts?: { forceScroll?: boolean }) {
  const lyrics = document.querySelector(".lyrics");
  if (!lyrics || !state.lyrics.length) return;
  bindLyricsScrollGuard(lyrics);

  const lines = lyrics.querySelectorAll(":scope > .lyric-line");
  const activeIdx = activeLyricIndex(state.position);
  state.lyrics.forEach((_, idx) => {
    lines[idx]?.classList.toggle("active-line", idx === activeIdx);
  });
  if (activeIdx >= 0) paintKaraoke(lyrics, activeIdx);

  if (activeIdx < 0) return;
  const force = opts?.forceScroll === true;
  const userScrolling = Date.now() < lyricsUserScrollUntil;
  if (!force && userScrolling) return;
  if (!force && activeIdx === lastLyricScrollIdx) return;

  lastLyricScrollIdx = activeIdx;
  const el = lines[activeIdx] as HTMLElement | undefined;
  if (!el) return;
  // Scroll only `.lyrics` (not ancestors) so the player dock stays put.
  // Use viewport math — offsetTop is unreliable when offsetParent isn't `.lyrics`.
  const box = lyrics as HTMLElement;
  const elRect = el.getBoundingClientRect();
  const boxRect = box.getBoundingClientRect();
  const delta =
    elRect.top + elRect.height / 2 - (boxRect.top + boxRect.height / 2);
  box.scrollTo({
    top: Math.max(0, box.scrollTop + delta),
    behavior: force ? "auto" : "smooth",
  });
}

function patchPlayerChrome() {
  const cur = document.querySelector("#time-cur");
  const dur = document.querySelector("#time-dur");
  if (cur) cur.textContent = formatTime(state.position);
  if (dur) dur.textContent = formatTime(state.duration);
  const seek = document.querySelector<HTMLInputElement>("#seek");
  if (seek && document.activeElement !== seek) {
    seek.max = String(Math.max(1, state.duration));
    seek.value = String(state.position);
  }
  syncLyricsHighlight();
  pushDesktopLyricsState();
}

let lastOsPosAt = 0;

/** Word-level karaoke needs sub-second frames; `timeupdate` fires only ~4/s. */
function startKaraokeTicker() {
  const step = () => {
    if (lyricHasWords && state.playing && state.lyricsOpen) {
      const lyrics = document.querySelector(".lyrics");
      const activeIdx = activeLyricIndex(audio.currentTime);
      if (lyrics && activeIdx >= 0) paintKaraoke(lyrics, activeIdx, audio.currentTime);
    }
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

audio.addEventListener("timeupdate", () => {
  state.position = audio.currentTime;
  state.duration = audio.duration || 0;
  patchPlayerChrome();
  persistSession();
  const now = Date.now();
  if (now - lastOsPosAt > 2000) {
    lastOsPosAt = now;
    syncOsMediaPosition(state.position, state.duration);
  }
});

function bouncePlayButton() {
  const btn = document.querySelector("#btn-pp");
  if (!btn) return;
  btn.classList.remove("pp-pop");
  void (btn as HTMLElement).offsetWidth;
  btn.classList.add("pp-pop");
}

audio.addEventListener("play", () => {
  state.playing = true;
  void maybeAttachEq();
  const btn = document.querySelector("#btn-pp");
  if (btn) btn.innerHTML = ICO.pause;
  document.querySelector(".player-dock")?.classList.add("is-playing");
  bouncePlayButton();
  patchTrackRowActive();
  syncOsMediaPlaybackState(true);
  pushOsMediaTrack();
  pushDesktopLyricsState({ immediate: true });
});

audio.addEventListener("pause", () => {
  state.playing = false;
  const btn = document.querySelector("#btn-pp");
  if (btn) btn.innerHTML = ICO.play;
  document.querySelector(".player-dock")?.classList.remove("is-playing");
  bouncePlayButton();
  patchTrackRowActive();
  syncOsMediaPlaybackState(false);
  writeSessionNow();
  pushDesktopLyricsState({ immediate: true });
});

audio.addEventListener("ended", () => {
  if (state.sleep?.mode === "track") {
    clearSleepTimer(true);
    state.playing = false;
    syncOsMediaPlaybackState(false);
    toast("本曲结束，已按定时停止");
    return;
  }
  if (state.playMode === "single") {
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
    return;
  }
  skip(1);
});

boot();
