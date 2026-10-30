import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./assets/fonts/fonts.css";
import "./styles.css";
import logoUrl from "./assets/logo.png";
import { formatTime, parseLrc } from "./lrc";
import {
  initOsMediaControls,
  syncOsMediaPlaybackState,
  syncOsMediaPosition,
  syncOsMediaTrack,
} from "./os-media";
import type {
  AppSettings,
  DownloadDirPreset,
  LibrarySnapshot,
  LyricLine,
  PlayMode,
  RecommendCatalog,
  RecommendPlaylist,
  SearchPageResult,
  SourceInfo,
  SourceSearchError,
  TabId,
  Track,
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
};

const VOLUME_KEY = "maoer-volume";
const RECENT_KEY = "maoer-recent";
const RECENT_MAX = 50;
const LYRIC_FONT_KEY = "maoer-lyric-font";
const LYRIC_OFFSET_KEY = "maoer-lyric-offset";
type LyricFontSize = "sm" | "md" | "lg";

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
    if (Number.isFinite(v)) return Math.max(-10, Math.min(10, Math.round(v * 2) / 2));
  } catch {
    /* ignore */
  }
  return 0;
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

function persistRecent(tracks: Track[]) {
  try {
    const compact = tracks.slice(0, RECENT_MAX).map((t) => ({
      uid: t.uid,
      source: t.source,
      title: t.title,
      artist: t.artist,
      album: t.album,
      cover: t.cover ?? null,
      songId: t.songId,
      songMid: t.songMid,
      qqId: t.qqId,
      qqSearchKey: t.qqSearchKey,
      qqIndex: t.qqIndex,
      keyword: t.keyword,
      displayIndex: t.displayIndex,
    }));
    localStorage.setItem(RECENT_KEY, JSON.stringify(compact));
  } catch {
    /* ignore quota */
  }
}

function pushRecent(track: Track) {
  const next = [track, ...state.recent.filter((t) => t.uid !== track.uid)].slice(0, RECENT_MAX);
  state.recent = next;
  persistRecent(next);
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
  recommend: null as RecommendCatalog | null,
  recommendLoading: false,
  settings: {
    enabledSources: [],
    limitPerSource: 10,
    downloadDir: "",
    sourcesDir: "",
  } as AppSettings,
  defaultDownloadDir: "",
  defaultSourcesDir: "",
  downloadingUid: "" as string,
  sources: [] as SourceInfo[],
  library: null as LibrarySnapshot | null,
  libraryPane: "favorites" as "favorites" | "recent" | "playlists",
  recent: loadRecent(),
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
  playMode: "list" as PlayMode,
  lyrics: [] as LyricLine[],
  lyricsOpen: false,
  lyricFont: loadLyricFont() as LyricFontSize,
  lyricOffset: loadLyricOffset(),
  toast: "",
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
  /** Sleep timer: timed countdown or stop after current track. */
  sleep: null as null | { mode: "timed"; endsAt: number; minutes: number } | { mode: "track" },
  /** One-shot enter animation after a full recommend reload. */
  recommendReveal: false,
  /** In-app dialog — WKWebView has no window.prompt/confirm. */
  dialog: null as
    | null
    | { kind: "new-playlist" }
    | { kind: "rename-playlist"; id: string; name: string }
    | { kind: "delete-playlist"; id: string; name: string }
    | { kind: "add-to-playlist"; trackUid: string }
    | { kind: "import-library"; path: string }
    | { kind: "sleep-timer" }
    | { kind: "pick-download-dir"; options: DownloadDirPreset[] },
  downloadDirPresets: [] as DownloadDirPreset[],
  /** Custom track context menu (native WebView menu only has Reload). */
  contextMenu: null as null | { x: number; y: number; trackUid: string; queueKey: string },
};

/** Suppress duplicate recommend-updated paints right after a user refresh. */
let ignoreRecommendEventsUntil = 0;

const SEARCH_HISTORY_KEY = "maoer-search-history";
const SEARCH_HISTORY_MAX = 12;

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

let playGeneration = 0;
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
    renderMain();
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

function applyVolume(next: number, opts?: { persist?: boolean; fromMute?: boolean }) {
  const v = Math.min(1, Math.max(0, next));
  state.volume = v;
  if (!opts?.fromMute) {
    state.muted = v <= 0.001;
    if (v > 0.001) state.volumeBeforeMute = v;
  }
  audio.volume = state.muted ? 0 : v;
  if (opts?.persist !== false && !state.muted) persistVolume(v);
  const slider = document.querySelector<HTMLInputElement>("#volume");
  if (slider && document.activeElement !== slider) slider.value = String(v);
  paintMuteButton();
}

function toggleMute() {
  if (state.muted || state.volume <= 0.001) {
    const restore = state.volumeBeforeMute > 0.001 ? state.volumeBeforeMute : 0.85;
    state.muted = false;
    applyVolume(restore);
  } else {
    state.volumeBeforeMute = state.volume > 0.001 ? state.volume : state.volumeBeforeMute;
    state.muted = true;
    audio.volume = 0;
    paintMuteButton();
  }
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
}

function openRecommendPlaylist(pl: RecommendPlaylist) {
  clearSearchResults();
  state.browsePlaylistId = pl.id;
  state.browsePage = 1;
  state.tab = "discover";
  if (pl.tracks.length) {
    void playTrack(pl.tracks[0], pl.tracks);
  }
  render();
}

function clearSearchResults() {
  state.searchTracks = [];
  state.searchAccum = [];
  state.searchErrors = [];
  state.searchLoadedMaxPage = 0;
  state.page = 1;
  state.searchHasMore = false;
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
    localStorage.setItem(LYRIC_OFFSET_KEY, String(state.lyricOffset));
  } catch {
    /* ignore */
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

function nudgeLyricOffset(delta: number) {
  state.lyricOffset = Math.max(-10, Math.min(10, Math.round((state.lyricOffset + delta) * 2) / 2));
  persistLyricPrefs();
  const label = document.querySelector("#lyric-offset-label");
  if (label) {
    label.textContent = formatLyricOffset(state.lyricOffset);
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
  render();
}

function setSleepAfterTrack() {
  clearSleepTimer(true);
  state.sleep = { mode: "track" };
  state.dialog = null;
  toast("本曲结束后暂停");
  render();
}

function openSleepTimerDialog() {
  state.dialog = { kind: "sleep-timer" };
  render();
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
  applyPlatformChrome();
  // Kill the default WebView menu (only "Reload") — we show our own on tracks.
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.contextMenu) closeContextMenu();
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
    };
    if (isAndroid()) {
      void ensureDownloadDirPresets();
    }
  } catch (e) {
    console.error(e);
  }
  render();
  void refreshRecommend(false);
  void listenRecommendUpdates();

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
      } else if (state.browsePlaylistId || state.tab === "library" || state.tab === "discover") {
        renderMain();
      }
    }, 280);
  });
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
  state.lyricsOpen = force ?? !state.lyricsOpen;
  render();
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

async function playTrack(track: Track, queue?: Track[], queueKind: null | "search" = null) {
  const gen = ++playGeneration;

  if (queue) {
    state.queue = queue;
    state.queueIndex = queue.findIndex((t) => t.uid === track.uid);
    state.queueKind = queueKind;
  } else if (state.queueIndex < 0 || state.queue[state.queueIndex]?.uid !== track.uid) {
    state.queue = [track];
    state.queueIndex = 0;
    state.queueKind = queueKind;
  }

  state.preparing = true;
  state.current = track;
  render();

  try {
    audio.pause();
    const detailed = await invoke<Track>("ensure_playable", { track });
    if (gen !== playGeneration) return;
    if (!detailed.audioUrl) {
      toast("暂无可用播放地址");
      state.preparing = false;
      render();
      return;
    }
    state.current = detailed;
    state.lyrics = parseLrc(detailed.lrc);
    lastLyricScrollIdx = -1;
    lyricsUserScrollUntil = 0;
    audio.src = toPlayableSrc(preferHttps(detailed.audioUrl));
    await audio.play();
    if (gen !== playGeneration) return;
    state.playing = true;
    state.duration = audio.duration || 0;
    state.position = audio.currentTime || 0;
    pushRecent(detailed);
    pushOsMediaTrack();
  } catch (e) {
    if (gen !== playGeneration || isAbortError(e)) return;
    toast(`播放失败：${String(e)}`);
    state.playing = false;
    pushOsMediaTrack();
  } finally {
    if (gen === playGeneration) {
      state.preparing = false;
      render();
      pushOsMediaTrack();
    }
  }
}

function playPause() {
  if (!state.current) return;
  if (state.playing) {
    audio.pause();
    state.playing = false;
  } else {
    void audio.play().then(
      () => {
        state.playing = true;
      },
      (e) => {
        if (!isAbortError(e)) toast(`播放失败：${String(e)}`);
      },
    );
  }
  // Button text comes from audio play/pause listeners — avoid full render (lyrics flash).
}

function skip(delta: number) {
  void skipAsync(delta);
}

async function skipAsync(delta: number) {
  if (!state.queue.length) return;
  if (state.playMode === "shuffle") {
    const next = Math.floor(Math.random() * state.queue.length);
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
    render();
  } catch (e) {
    toast(String(e));
  }
}

async function saveSettings(next: AppSettings) {
  state.settings = await invoke<AppSettings>("save_settings", { settings: next });
  toast("设置已保存");
  render();
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
    render();
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
  const input = document.querySelector<HTMLInputElement>("#download-dir-input");
  if (input) input.value = path;
  await saveSettings({ ...state.settings, downloadDir: path });
}

async function reloadSources() {
  try {
    state.sources = await invoke<SourceInfo[]>("list_sources");
    state.settings = await invoke<AppSettings>("get_settings");
    render();
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

async function downloadTrack(track: Track) {
  if (state.downloadingUid) {
    toast("已有下载任务进行中");
    return;
  }
  state.downloadingUid = track.uid;
  render();
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
    render();
  }
}

function openNewPlaylistDialog() {
  state.dialog = { kind: "new-playlist" };
  render();
}

function openRenamePlaylistDialog(id: string, name: string) {
  state.dialog = { kind: "rename-playlist", id, name };
  render();
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
    render();
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
    render();
  } catch (e) {
    toast(String(e));
  }
}

function openDeletePlaylistDialog(id: string, name: string) {
  state.dialog = { kind: "delete-playlist", id, name };
  render();
}

async function confirmDeletePlaylist(id: string) {
  try {
    await invoke("delete_playlist", { id });
    state.library = await invoke<LibrarySnapshot>("get_library");
    state.dialog = null;
    toast("歌单已删除");
    render();
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
    render();
  } catch (e) {
    toast(String(e));
  }
}

async function movePlaylistTrack(playlistId: string, fromIndex: number, toIndex: number) {
  try {
    await invoke("move_playlist_track", { playlistId, fromIndex, toIndex });
    state.library = await invoke<LibrarySnapshot>("get_library");
    render();
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
    render();
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
    render();
  } catch (e) {
    toast(`导入失败：${String(e)}`);
  }
}

function closeDialog() {
  state.dialog = null;
  render();
}

function closeContextMenu() {
  if (!state.contextMenu) return;
  state.contextMenu = null;
  render();
}

function openTrackContextMenu(e: MouseEvent, trackUid: string, queueKey: string) {
  e.preventDefault();
  e.stopPropagation();
  state.contextMenu = { x: e.clientX, y: e.clientY, trackUid, queueKey };
  render();
}

function queueFromKey(key: string): Track[] {
  if (key === "search") {
    return state.searchAccum.length ? state.searchAccum : state.searchTracks;
  }
  if (key === "hot") return state.recommend?.hotTracks ?? [];
  if (key === "fav") return (state.library?.favorites ?? []).map(storedToTrack);
  if (key === "recent") return state.recent.slice();
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
      <div class="ctx-sep"></div>
      <button type="button" class="ctx-item" data-ctx="download" role="menuitem">下载</button>
    </div>`;
}

function openAddToPlaylistDialog(trackUid: string) {
  const playlists = state.library?.playlists ?? [];
  if (!playlists.length) {
    toast("先在「我的」里新建一个歌单");
    return;
  }
  state.dialog = { kind: "add-to-playlist", trackUid };
  render();
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
    render();
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

function coverUrl(track?: Track | null): string {
  const raw = track?.cover?.trim();
  if (raw) {
    // QQ CDN often returns http://; WKWebView blocks mixed-content images.
    return preferHttps(raw);
  }
  return (
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1b2340"/><stop offset="1" stop-color="#3d8bfd" stop-opacity=".35"/></linearGradient></defs><rect fill="url(#g)" width="120" height="120"/><text x="60" y="68" text-anchor="middle" fill="#a1a6d0" font-size="34">♪</text></svg>`,
    )
  );
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
    state.recent.find((t) => t.uid === uid) ||
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
  return `<span class="fav-btn${on ? " is-fav" : ""}" data-fav-uid="${escapeAttr(uid)}" title="${on ? "取消收藏" : "收藏"}" role="button" aria-pressed="${on}">${on ? "♥" : "♡"}</span>`;
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

function trackRow(track: Track, index: number, queueKey = "", listLen = 0) {
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
  return `
    <button class="track-row ${active ? "active" : ""}" type="button" data-play-uid="${escapeAttr(track.uid)}">
      <span class="idx">${active && state.playing ? "♪" : idx}</span>
      <img class="cover" src="${escapeAttr(coverUrl(track))}" alt="" />
      <div class="meta">
        <div class="title">${escapeHtml(track.title || "未知歌曲")}</div>
        <div class="sub">${escapeHtml(track.album || "单曲")}</div>
      </div>
      <div class="artist-col">${escapeHtml(track.artist || "未知歌手")}</div>
      <span class="badge">${escapeHtml(SOURCE_LABEL[track.source] || track.source)}</span>
      <div class="row-actions">
        ${plActions}
        <span class="fav-btn" data-dl-uid="${escapeAttr(track.uid)}" title="下载" role="button">${dlBusy ? "…" : "⬇"}</span>
        ${favButton(track.uid)}
      </div>
    </button>
  `;
}

function trackList(tracks: Track[], queueKey: string, startIndex = 0): string {
  if (!tracks.length) return emptyState("♪", "暂无歌曲", "换个关键词或稍后再试");
  return `
    <div class="track-list" data-queue="${escapeAttr(queueKey)}">
      <div class="track-list-head">
        <span>#</span><span></span><span>歌曲</span><span class="col-artist">歌手</span><span>来源</span><span></span>
      </div>
      ${tracks.map((t, i) => trackRow(t, startIndex + i, queueKey, startIndex + tracks.length)).join("")}
    </div>
  `;
}

function renderDiscover(): string {
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
          ${renderPager({
            key: "browse",
            page: sliced.page,
            totalPages: sliced.totalPages,
            ariaLabel: "歌单分页",
          })}
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
          <div class="pager" role="navigation" aria-label="搜索分页">
            <button class="btn ghost sm" id="btn-search-prev" type="button" ${
              state.searching || state.page <= 1 ? "disabled" : ""
            }>上一页</button>
            <span class="pager-indicator">第 ${state.page} 页</span>
            <button class="btn ghost sm" id="btn-search-next" type="button" ${
              state.searching || !state.searchHasMore ? "disabled" : ""
            }>下一页</button>
          </div>
        </div>
        ${
          state.searchTracks.length
            ? trackList(state.searchTracks, "search")
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
              <img src="${escapeAttr(preferHttps(p.cover || "") || coverUrl(p.tracks[0]))}" alt="" />
              <span class="play-badge">▶</span>
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
            : renderPager({
                key: "hot",
                page: hot.page,
                totalPages: hot.totalPages,
                ariaLabel: "热门歌曲分页",
              }) || `<span class="hint">点击即播 · 共 ${hot.total} 首</span>`
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
                      ${
                        renderPager({
                          key: "fav",
                          page: favs.page,
                          totalPages: favs.totalPages,
                          ariaLabel: "我喜欢分页",
                        }) || `<span class="hint">共 ${favs.total} 首</span>`
                      }
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
                        </div>
                      </div>
                      ${trackList(recent.items, "recent", recent.startIndex)}`
                    : emptyState("◷", "还没有播放记录", "听几首歌后，最近播放会出现在这里")
                }
              </section>`
            : `<section class="lib-pane">
              <div class="lib-pane-actions">
                <button class="btn ghost sm" id="btn-new-playlist" type="button">新建歌单</button>
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

function renderSettings(): string {
  const enabled = new Set(state.settings.enabledSources);
  const downloadDir =
    state.settings.downloadDir.trim() || state.defaultDownloadDir || "~/Music/猫耳收音机";
  const android = isAndroid();
  return `
    <h1 class="page-title page-title-sm">设置</h1>
    <div class="settings-stack">
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
          return `<button type="button" class="lyric-line${active ? " active-line" : ""}" data-lyric-idx="${idx}" title="跳到这句">${escapeHtml(line.text || " ")}</button>`;
        })
        .join("")
    : emptyState("¶", "暂无歌词", "这首歌没有附带 LRC");

  return `
    <div class="lp-head">
      <h3>${state.preparing ? "准备中…" : "歌词"}</h3>
      <button class="icon-btn" id="btn-close-lyrics" type="button" title="关闭">✕</button>
    </div>
    <img class="cover lg" src="${escapeAttr(coverUrl(t))}" alt="" />
    <h2 class="np-title">${escapeHtml(t.title)}</h2>
    <p class="np-artist">${escapeHtml(t.artist)} · ${SOURCE_LABEL[t.source] || t.source}</p>
    <div class="lp-tools" role="toolbar" aria-label="歌词设置">
      <button class="btn ghost sm" type="button" id="btn-lyric-font-down" title="缩小歌词">A−</button>
      <button class="btn ghost sm" type="button" id="btn-lyric-font-up" title="放大歌词">A+</button>
      <span class="lp-tools-sep" aria-hidden="true"></span>
      <button class="btn ghost sm" type="button" id="btn-lyric-offset-down" title="歌词提前 0.5 秒">−0.5</button>
      <span class="lp-offset" id="lyric-offset-label" title="歌词时间偏移">${formatLyricOffset(state.lyricOffset)}</span>
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
        state.searchTracks.length || state.browsePlaylistId
          ? `<button class="back-btn" id="btn-clear-search" type="button" title="返回发现" aria-label="返回发现">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M15 18l-6-6 6-6"/>
              </svg>
            </button>`
          : ""
      }
      <div class="search-row">
        <div class="search-field">
          <input id="search-input" placeholder="搜索歌曲、歌手" value="${escapeAttr(state.keyword)}" autocomplete="off" />
          ${
            state.searchHistoryOpen && loadSearchHistory().length
              ? `<div class="search-history" id="search-history">
                  <div class="search-history-head">
                    <span>搜索历史</span>
                    <button type="button" class="search-history-clear" id="btn-clear-history">清空</button>
                  </div>
                  ${loadSearchHistory()
                    .map(
                      (h) => `
                    <button type="button" class="search-history-item" data-history="${escapeAttr(h)}">
                      <span class="search-history-text">${escapeHtml(h)}</span>
                      <span class="search-history-del" data-history-del="${escapeAttr(h)}" title="删除">×</span>
                    </button>`,
                    )
                    .join("")}
                </div>`
              : ""
          }
        </div>
        <button class="btn sm" id="btn-search" ${state.searching ? "disabled" : ""}>${
          state.searching ? "搜索中…" : "搜索"
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
  afterRenderMotion();
}

function render() {
  const current = state.current;
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
            <span class="nav-ico">♪</span><span class="label">发现</span>
          </button>
          <button data-tab="library" class="${state.tab === "library" ? "active" : ""}" type="button">
            <span class="nav-ico">♡</span><span class="label">我的</span>
          </button>
          <button data-tab="settings" class="${state.tab === "settings" ? "active" : ""}" type="button">
            <span class="nav-ico">⚙</span><span class="label">设置</span>
          </button>
        </nav>
      </aside>

      <main class="main">${renderMainColumnHtml()}</main>

      <aside class="lyrics-panel">${renderLyricsPanel()}</aside>

      <footer class="player-dock">
        ${
          current
            ? `<button class="player-now" type="button" id="toggle-lyrics" title="查看歌词">
                <img class="cover" src="${escapeAttr(coverUrl(current))}" alt="" />
                <div class="meta">
                  <div class="title">${escapeHtml(current.title)}</div>
                  <div class="sub">${escapeHtml(current.artist)}${state.preparing ? " · 准备中" : ""}</div>
                </div>
                ${favButton(current.uid)}
              </button>`
            : `<div class="player-now">
                <img class="cover" src="${escapeAttr(coverUrl(null))}" alt="" style="opacity:.5" />
                <div class="meta"><div class="title">未在播放</div><div class="sub">从列表选一首歌</div></div>
              </div>`
        }
        <div class="player-controls">
          <div class="btns">
            <button class="icon-btn" id="btn-prev" type="button" title="上一首">⏮</button>
            <button class="icon-btn primary" id="btn-pp" type="button" title="播放/暂停">${
              state.preparing ? "…" : state.playing ? "⏸" : "▶"
            }</button>
            <button class="icon-btn" id="btn-next" type="button" title="下一首">⏭</button>
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
          <button class="mode-btn${state.sleep ? " is-active" : ""}" id="btn-sleep" type="button" title="${
            state.sleep ? "定时关闭中 · 点击调整" : "定时关闭"
          }">${sleepLabel()}</button>
          <button class="mode-btn" id="toggle-lyrics-2" type="button">${showLyrics ? "收起" : "歌词"}</button>
        </div>
      </footer>
    </div>
    ${renderDialog()}
    ${renderContextMenu()}
    <div class="toast ${state.toast ? "" : "hidden"}">${escapeHtml(state.toast)}</div>
  `;

  bindEvents();
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
}

function bindChromeEvents() {
  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tab = btn.dataset.tab as TabId;
      renderMain();
    });
  });

  document.querySelector("#btn-pp")?.addEventListener("click", () => playPause());
  document.querySelector("#btn-prev")?.addEventListener("click", () => skip(-1));
  document.querySelector("#btn-next")?.addEventListener("click", () => skip(1));
  document.querySelector("#btn-mode-bar")?.addEventListener("click", () => cyclePlayMode());
  document.querySelector("#btn-sleep")?.addEventListener("click", () => openSleepTimerDialog());
  document.querySelector("#btn-fav-np")?.addEventListener("click", () => {
    if (state.current) void toggleFavorite(state.current);
  });
  document.querySelector("#btn-close-lyrics")?.addEventListener("click", () => toggleLyrics(false));
  document.querySelector("#toggle-lyrics-2")?.addEventListener("click", () => toggleLyrics());
  document.querySelector("#btn-lyric-font-down")?.addEventListener("click", () => cycleLyricFont(-1));
  document.querySelector("#btn-lyric-font-up")?.addEventListener("click", () => cycleLyricFont(1));
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

  const playerNow = document.querySelector("#toggle-lyrics");
  playerNow?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
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

function bindMainEvents() {
  document.querySelectorAll<HTMLButtonElement>("[data-lib-pane]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.libraryPane = btn.dataset.libPane as "favorites" | "recent" | "playlists";
      renderMain();
    });
  });
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
  });
  searchInput?.addEventListener("focus", () => {
    if (!loadSearchHistory().length || state.searchHistoryOpen) return;
    state.searchHistoryOpen = true;
    renderMain();
    document.querySelector<HTMLInputElement>("#search-input")?.focus();
  });
  searchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void doSearch(true);
    if (e.key === "Escape" && state.searchHistoryOpen) {
      state.searchHistoryOpen = false;
      detachSearchHistoryDocHandler();
      renderMain();
    }
  });
  if (state.searchHistoryOpen) {
    attachSearchHistoryDocHandler();
  } else {
    detachSearchHistoryDocHandler();
  }
  document.querySelector("#btn-clear-history")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearSearchHistory();
    state.searchHistoryOpen = false;
    detachSearchHistoryDocHandler();
    renderMain();
  });
  document.querySelectorAll<HTMLElement>("[data-history]").forEach((el) => {
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("click", (e) => {
      const del = (e.target as HTMLElement).closest("[data-history-del]") as HTMLElement | null;
      if (del) {
        e.preventDefault();
        e.stopPropagation();
        removeSearchHistory(del.dataset.historyDel || "");
        if (!loadSearchHistory().length) {
          state.searchHistoryOpen = false;
          detachSearchHistoryDocHandler();
        }
        renderMain();
        if (state.searchHistoryOpen) {
          document.querySelector<HTMLInputElement>("#search-input")?.focus();
        }
        return;
      }
      const kw = el.dataset.history || "";
      state.keyword = kw;
      void doSearch(true);
    });
  });
  document.querySelector("#btn-search")?.addEventListener("click", () => void doSearch(true));
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

  document.querySelector("#btn-new-playlist")?.addEventListener("click", () => openNewPlaylistDialog());
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
    void saveSettings({
      ...state.settings,
      enabledSources: enabled,
      limitPerSource: Math.min(30, Math.max(5, limit || 10)),
      downloadDir,
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
        render();
        return;
      }
      if (action === "play") {
        void playTrack(track, queueFromKey(menu.queueKey), queueKindFor(menu.queueKey));
        render();
        return;
      }
      if (action === "add-pl") {
        render();
        openAddToPlaylistDialog(track.uid);
        return;
      }
      if (action === "remove-pl") {
        const playlistId = menu.queueKey.startsWith("pl-") ? menu.queueKey.slice(3) : "";
        if (playlistId) {
          void removeTrackFromPlaylist(playlistId, track.uid);
          return;
        }
        render();
        return;
      }
      if (action === "fav") {
        void toggleFavorite(track);
        return;
      }
      if (action === "download") {
        void downloadTrack(track);
        render();
        return;
      }
      render();
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
        render();
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
    }
    if (e.key === "Escape") closeDialog();
  });
  if (dialogInput) {
    dialogInput.focus();
    dialogInput.select();
  }
}

/** Last lyric index we scrolled to — avoid smooth-scroll spam on every timeupdate. */
let lastLyricScrollIdx = -1;
/** Ignore auto-scroll briefly after the user manually scrolls the lyrics pane. */
let lyricsUserScrollUntil = 0;

function activeLyricIndex(position: number): number {
  if (!state.lyrics.length) return -1;
  // Positive offset = lyrics feel late → compare against an earlier clock.
  const t = position - state.lyricOffset;
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

function syncLyricsHighlight(opts?: { forceScroll?: boolean }) {
  const lyrics = document.querySelector(".lyrics");
  if (!lyrics || !state.lyrics.length) return;
  bindLyricsScrollGuard(lyrics);

  const lines = lyrics.querySelectorAll(":scope > .lyric-line");
  const activeIdx = activeLyricIndex(state.position);
  state.lyrics.forEach((_, idx) => {
    lines[idx]?.classList.toggle("active-line", idx === activeIdx);
  });

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
}

let lastOsPosAt = 0;

audio.addEventListener("timeupdate", () => {
  state.position = audio.currentTime;
  state.duration = audio.duration || 0;
  patchPlayerChrome();
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
  const btn = document.querySelector("#btn-pp");
  if (btn) btn.textContent = "⏸";
  bouncePlayButton();
  syncOsMediaPlaybackState(true);
  pushOsMediaTrack();
});

audio.addEventListener("pause", () => {
  state.playing = false;
  const btn = document.querySelector("#btn-pp");
  if (btn) btn.textContent = "▶";
  bouncePlayButton();
  syncOsMediaPlaybackState(false);
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
