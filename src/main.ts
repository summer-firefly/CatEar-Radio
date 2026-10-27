import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import "./styles.css";
import logoUrl from "./assets/logo.png";
import { formatTime, parseLrc } from "./lrc";
import type {
  AppSettings,
  DownloadDirPreset,
  LibrarySnapshot,
  LyricLine,
  PlayMode,
  RecommendCatalog,
  SourceInfo,
  TabId,
  Track,
} from "./types";

function isAndroid(): boolean {
  return (
    document.documentElement.classList.contains("is-android") ||
    /android/i.test(navigator.userAgent || "")
  );
}

type DesktopLyricPayload = {
  line: string;
  next: string;
  title: string;
  artist: string;
};

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

const state = {
  tab: "discover" as TabId,
  keyword: "",
  searching: false,
  searchTracks: [] as Track[],
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
  libraryPane: "favorites" as "favorites" | "playlists",
  queue: [] as Track[],
  queueIndex: -1,
  current: null as Track | null,
  playing: false,
  preparing: false,
  position: 0,
  duration: 0,
  playMode: "list" as PlayMode,
  lyrics: [] as LyricLine[],
  lyricsOpen: false,
  desktopLyrics: false,
  toast: "",
  page: 1,
  searchHistoryOpen: false,
  /** One-shot enter animation after a full recommend reload. */
  recommendReveal: false,
  /** In-app dialog — WKWebView has no window.prompt/confirm. */
  dialog: null as
    | null
    | { kind: "new-playlist" }
    | { kind: "delete-playlist"; id: string; name: string }
    | { kind: "add-to-playlist"; trackUid: string }
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
let lastDesktopLyricLine = "";
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
// Do not set crossOrigin: many music CDNs omit CORS headers, which makes
// HTMLMediaElement.play() reject with NotSupportedError in WKWebView.

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

async function boot() {
  applyPlatformChrome();
  // Kill the default WebView menu (only "Reload") — we show our own on tracks.
  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.contextMenu) closeContextMenu();
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
  void listenDesktopLyricsReady();
}

async function listenDesktopLyricsReady() {
  try {
    await listen("desktop-lyrics-ready", () => {
      void syncDesktopLyrics(true);
    });
  } catch (e) {
    console.error(e);
  }
}

function currentDesktopLyricPayload(): DesktopLyricPayload {
  const title = state.current?.title || "";
  const artist = state.current?.artist || "";
  if (!state.lyrics.length) {
    return {
      line: title || "暂无歌词",
      next: artist,
      title,
      artist,
    };
  }
  let idx = 0;
  for (let i = 0; i < state.lyrics.length; i++) {
    const next = state.lyrics[i + 1];
    if (state.position >= state.lyrics[i].time && (!next || state.position < next.time)) {
      idx = i;
      break;
    }
    if (state.position < state.lyrics[0].time) {
      idx = 0;
      break;
    }
    if (i === state.lyrics.length - 1) idx = i;
  }
  return {
    line: state.lyrics[idx]?.text || title || "暂无歌词",
    next: state.lyrics[idx + 1]?.text || "",
    title,
    artist,
  };
}

async function syncDesktopLyrics(force = false) {
  if (!state.desktopLyrics) return;
  const payload = currentDesktopLyricPayload();
  if (!force && payload.line === lastDesktopLyricLine) return;
  lastDesktopLyricLine = payload.line;
  try {
    await emit("desktop-lyrics-sync", payload);
  } catch {
    // Window may have closed between checks.
  }
}

function patchDesktopLyricsBtn() {
  const btn = document.querySelector("#btn-desktop-lyrics");
  if (btn) btn.textContent = state.desktopLyrics ? "关闭桌面歌词" : "桌面歌词";
}

async function toggleDesktopLyrics() {
  try {
    const existing = await WebviewWindow.getByLabel("desktop-lyrics");
    if (existing) {
      await existing.close();
      state.desktopLyrics = false;
      lastDesktopLyricLine = "";
      patchDesktopLyricsBtn();
      return;
    }

    const win = new WebviewWindow("desktop-lyrics", {
      url: "desktop-lyrics.html",
      title: "桌面歌词",
      width: 920,
      height: 120,
      minWidth: 320,
      minHeight: 96,
      center: true,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: true,
      shadow: false,
      focus: false,
    });

    win.once("tauri://created", () => {
      state.desktopLyrics = true;
      patchDesktopLyricsBtn();
      void syncDesktopLyrics(true);
    });
    win.once("tauri://error", (e) => {
      state.desktopLyrics = false;
      patchDesktopLyricsBtn();
      toast(`桌面歌词打开失败：${String(e.payload ?? e)}`);
    });
    win.once("tauri://destroyed", () => {
      state.desktopLyrics = false;
      lastDesktopLyricLine = "";
      patchDesktopLyricsBtn();
    });
  } catch (e) {
    toast(`桌面歌词打开失败：${String(e)}`);
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
    renderMain();
  }
  try {
    const catalog = fromUser
      ? await invoke<RecommendCatalog>("refresh_recommend")
      : await invoke<RecommendCatalog>("load_recommend");
    state.recommend = catalog;
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
  if (reset) state.page = 1;
  state.tab = "discover";
  state.searching = true;
  renderMain();
  try {
    state.searchTracks = await invoke<Track[]>("search_tracks", {
      keyword,
      page: state.page,
      reset,
    });
    if (!state.searchTracks.length) toast("没有找到结果");
  } catch (e) {
    toast(String(e));
  } finally {
    state.searching = false;
    renderMain();
  }
}

function clearSearch() {
  state.searchTracks = [];
  state.keyword = "";
  state.page = 1;
  state.tab = "discover";
  renderMain();
}

function toggleLyrics(force?: boolean) {
  state.lyricsOpen = force ?? !state.lyricsOpen;
  render();
}

async function loadMore() {
  state.page += 1;
  state.searching = true;
  renderMain();
  try {
    state.searchTracks = await invoke<Track[]>("search_tracks", {
      keyword: state.keyword,
      page: state.page,
      reset: false,
    });
  } catch (e) {
    toast(String(e));
    state.page = Math.max(1, state.page - 1);
  } finally {
    state.searching = false;
    renderMain();
  }
}

async function playTrack(track: Track, queue?: Track[]) {
  const gen = ++playGeneration;

  if (queue) {
    state.queue = queue;
    state.queueIndex = queue.findIndex((t) => t.uid === track.uid);
  } else if (state.queueIndex < 0 || state.queue[state.queueIndex]?.uid !== track.uid) {
    state.queue = [track];
    state.queueIndex = 0;
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
    lastDesktopLyricLine = "";
    audio.src = toPlayableSrc(preferHttps(detailed.audioUrl));
    await audio.play();
    if (gen !== playGeneration) return;
    state.playing = true;
    void syncDesktopLyrics(true);
  } catch (e) {
    if (gen !== playGeneration || isAbortError(e)) return;
    toast(`播放失败：${String(e)}`);
    state.playing = false;
  } finally {
    if (gen === playGeneration) {
      state.preparing = false;
      render();
      void syncDesktopLyrics(true);
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
  if (!state.queue.length) return;
  if (state.playMode === "shuffle") {
    const next = Math.floor(Math.random() * state.queue.length);
    state.queueIndex = next;
    void playTrack(state.queue[next], state.queue);
    return;
  }
  const next = state.queueIndex + delta;
  if (next < 0 || next >= state.queue.length) {
    if (state.playMode === "list" && state.queue.length) {
      state.queueIndex = delta > 0 ? 0 : state.queue.length - 1;
      void playTrack(state.queue[state.queueIndex], state.queue);
    }
    return;
  }
  state.queueIndex = next;
  void playTrack(state.queue[next], state.queue);
}

function cyclePlayMode() {
  const order: PlayMode[] = ["list", "single", "shuffle"];
  const i = order.indexOf(state.playMode);
  state.playMode = order[(i + 1) % order.length];
  const modeBtn = document.querySelector("#btn-mode-bar");
  if (modeBtn) modeBtn.textContent = modeLabel();
  toast(
    state.playMode === "list"
      ? "列表循环"
      : state.playMode === "single"
        ? "单曲循环"
        : "随机播放",
  );
}

async function toggleFavorite(track: Track) {
  try {
    const added = await invoke<boolean>("toggle_favorite", { track });
    state.library = await invoke<LibrarySnapshot>("get_library");
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
    const path = await invoke<string>("download_track", { track });
    toast(`已下载：${path}`);
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
  if (key === "search") return state.searchTracks;
  if (key === "hot") return state.recommend?.hotTracks.slice(0, 16) ?? [];
  if (key === "fav") return (state.library?.favorites ?? []).map(storedToTrack);
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
  // Rough clamp before measure; refined after paint in bindEvents.
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 180));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - 200));
  return `
    <div class="ctx-backdrop" id="ctx-backdrop"></div>
    <div class="ctx-menu" id="ctx-menu" style="left:${left}px;top:${top}px" role="menu">
      <button type="button" class="ctx-item" data-ctx="play" role="menuitem">播放</button>
      <button type="button" class="ctx-item" data-ctx="add-pl" role="menuitem">加入歌单</button>
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

function trackRow(track: Track, index: number) {
  const active = state.current?.uid === track.uid;
  const idx = String(index + 1).padStart(2, "0");
  const dlBusy = state.downloadingUid === track.uid;
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
        <span class="fav-btn" data-add-pl-uid="${escapeAttr(track.uid)}" title="加入歌单" role="button">＋</span>
        <span class="fav-btn" data-dl-uid="${escapeAttr(track.uid)}" title="下载" role="button">${dlBusy ? "…" : "⬇"}</span>
        ${favButton(track.uid)}
      </div>
    </button>
  `;
}

function trackList(tracks: Track[], queueKey: string): string {
  if (!tracks.length) return `<div class="empty">暂无歌曲</div>`;
  return `
    <div class="track-list" data-queue="${escapeAttr(queueKey)}">
      <div class="track-list-head">
        <span>#</span><span></span><span>歌曲</span><span class="col-artist">歌手</span><span>来源</span><span></span>
      </div>
      ${tracks.map((t, i) => trackRow(t, i)).join("")}
    </div>
  `;
}

function renderDiscover(): string {
  const hot = state.recommend?.hotTracks?.slice(0, 20) ?? [];
  const playlists = state.recommend?.hotPlaylists ?? [];
  const hasSearch = state.searchTracks.length > 0;

  if (hasSearch) {
    return `
      <h1 class="page-title">搜索结果<span class="sub">共 ${state.searchTracks.length} 首 · 「${escapeHtml(state.keyword)}」</span></h1>
      ${state.searching ? `<div class="status">搜索中…</div>` : ""}
      <div class="section">
        <div class="section-head">
          <h2>歌曲</h2>
          <button class="btn ghost sm" id="btn-load-more" ${state.searching ? "disabled" : ""}>加载更多</button>
        </div>
        ${trackList(state.searchTracks, "search")}
      </div>
    `;
  }

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
              : `<div class="empty">暂无歌单</div>`
        }
      </div>
    </section>
    <section class="section ${refreshing ? "is-refreshing" : reveal ? "rec-enter" : ""}">
      <div class="section-head">
        <h2>热门歌曲</h2>
        <span class="hint">${refreshing ? "正在拉取最新推荐…" : "点击即播"}</span>
      </div>
      ${refreshing ? trackSkeleton(8) : trackList(hot, "hot")}
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
  const favs = (state.library?.favorites ?? []).map(storedToTrack);
  const playlists = state.library?.playlists ?? [];
  const pane = state.libraryPane;
  const favActive = pane === "favorites";
  return `
    <h1 class="page-title page-title-sm">我的<span class="sub">收藏与自建歌单</span></h1>
    <div class="library-stack">
      <div class="lib-tabs" role="tablist">
        <button type="button" class="lib-tab ${favActive ? "active" : ""}" data-lib-pane="favorites" role="tab" aria-selected="${favActive}">
          我喜欢 · ${favs.length}
        </button>
        <button type="button" class="lib-tab ${!favActive ? "active" : ""}" data-lib-pane="playlists" role="tab" aria-selected="${!favActive}">
          自建歌单 · ${playlists.length}
        </button>
      </div>
      ${
        favActive
          ? `<section class="lib-pane">
              ${
                favs.length
                  ? trackList(favs, "fav")
                  : `<div class="empty empty-sm">还没有收藏，去发现页点 ♡ 吧</div>`
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
                            <button class="btn ghost sm" data-del-playlist="${escapeAttr(p.id)}" type="button">删除</button>
                          </div>
                          ${
                            tracks.length
                              ? trackList(tracks, `pl-${p.id}`)
                              : `<div class="empty empty-sm">空歌单 · 在歌曲上点 ＋ 加入</div>`
                          }
                        </div>`;
                      })
                      .join("")
                  : `<div class="empty empty-sm">还没有自建歌单。建好后，在歌曲右侧点 ＋ 即可加入</div>`
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
            : `<div class="empty empty-sm">暂无可用音源</div>`
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

function renderLyricsPanel(): string {
  const t = state.current;
  if (!t) {
    return `
      <div class="lp-head">
        <h3>歌词</h3>
        <button class="icon-btn" id="btn-close-lyrics" type="button" title="关闭">✕</button>
      </div>
      <div class="empty">播放歌曲后显示歌词</div>
    `;
  }

  const lyricHtml = state.lyrics.length
    ? state.lyrics
        .map((line, idx) => {
          const next = state.lyrics[idx + 1];
          const active =
            state.position >= line.time && (!next || state.position < next.time);
          return `<div class="${active ? "active-line" : ""}">${escapeHtml(line.text)}</div>`;
        })
        .join("")
    : `<div class="empty">暂无歌词</div>`;

  return `
    <div class="lp-head">
      <h3>${state.preparing ? "准备中…" : "歌词"}</h3>
      <button class="icon-btn" id="btn-close-lyrics" type="button" title="关闭">✕</button>
    </div>
    <img class="cover lg" src="${escapeAttr(coverUrl(t))}" alt="" />
    <h2 class="np-title">${escapeHtml(t.title)}</h2>
    <p class="np-artist">${escapeHtml(t.artist)} · ${SOURCE_LABEL[t.source] || t.source}</p>
    <div class="lyrics">${lyricHtml}</div>
    <div class="lp-head" style="justify-content:center;gap:8px;border-top:1px solid var(--line);padding-top:12px;padding-bottom:16px">
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
        state.searchTracks.length
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
        <button class="btn sm" id="btn-search" ${state.searching ? "disabled" : ""}>搜索</button>
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
          <div class="time-row">
            <span id="time-cur">${formatTime(state.position)}</span>
            <input class="seek" id="seek" type="range" min="0" max="${Math.max(1, state.duration)}" step="0.1" value="${state.position}" />
            <span id="time-dur">${formatTime(state.duration)}</span>
          </div>
        </div>
        <div class="player-extra">
          <button class="mode-btn" id="btn-mode-bar" type="button">${modeLabel()}</button>
          <button class="mode-btn" id="toggle-lyrics-2" type="button">${showLyrics ? "收起歌词" : "歌词"}</button>
          <button class="mode-btn" id="btn-desktop-lyrics" type="button">${state.desktopLyrics ? "关闭桌面歌词" : "桌面歌词"}</button>
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
}

function queueFor(el: Element | null): Track[] {
  const root = el?.closest("[data-queue]") as HTMLElement | null;
  const key = root?.dataset.queue;
  return key ? queueFromKey(key) : state.queue.length ? state.queue : state.current ? [state.current] : [];
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
  document.querySelector("#btn-fav-np")?.addEventListener("click", () => {
    if (state.current) void toggleFavorite(state.current);
  });
  document.querySelector("#btn-close-lyrics")?.addEventListener("click", () => toggleLyrics(false));
  document.querySelector("#toggle-lyrics-2")?.addEventListener("click", () => toggleLyrics());
  document.querySelector("#btn-desktop-lyrics")?.addEventListener("click", () => {
    void toggleDesktopLyrics();
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
    audio.currentTime = Number(seek.value);
    state.position = audio.currentTime;
  });
}

function bindMainEvents() {
  document.querySelectorAll<HTMLButtonElement>("[data-lib-pane]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.libraryPane = btn.dataset.libPane as "favorites" | "playlists";
      renderMain();
    });
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
  document.querySelector("#btn-load-more")?.addEventListener("click", () => void loadMore());
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
      if (track) void playTrack(track, queueFor(row));
    });
    row.addEventListener("contextmenu", (e) => {
      const root = row.closest("[data-queue]") as HTMLElement | null;
      openTrackContextMenu(e, row.dataset.playUid!, root?.dataset.queue || "");
    });
  });

  document.querySelectorAll<HTMLElement>("[data-playlist-id]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pl = state.recommend?.hotPlaylists.find((p) => p.id === btn.dataset.playlistId);
      if (pl?.tracks?.length) {
        state.searchTracks = pl.tracks;
        state.keyword = pl.name;
        state.tab = "discover";
        void playTrack(pl.tracks[0], pl.tracks);
        render();
      }
    });
  });

  document.querySelector("#btn-new-playlist")?.addEventListener("click", () => openNewPlaylistDialog());
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
        void playTrack(track, queueFromKey(menu.queueKey));
        render();
        return;
      }
      if (action === "add-pl") {
        render();
        openAddToPlaylistDialog(track.uid);
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
    } else if (d.kind === "delete-playlist") {
      void confirmDeletePlaylist(d.id);
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
  dialogInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submitNewPlaylist(dialogInput.value);
    if (e.key === "Escape") closeDialog();
  });
  if (dialogInput) {
    dialogInput.focus();
    dialogInput.select();
  }
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
  const lyrics = document.querySelector(".lyrics");
  if (lyrics) {
    const lines = lyrics.querySelectorAll("div");
    state.lyrics.forEach((line, idx) => {
      const next = state.lyrics[idx + 1];
      const active = state.position >= line.time && (!next || state.position < next.time);
      lines[idx]?.classList.toggle("active-line", active);
    });
  }
}

audio.addEventListener("timeupdate", () => {
  state.position = audio.currentTime;
  state.duration = audio.duration || 0;
  patchPlayerChrome();
  void syncDesktopLyrics(false);
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
});

audio.addEventListener("pause", () => {
  state.playing = false;
  const btn = document.querySelector("#btn-pp");
  if (btn) btn.textContent = "▶";
  bouncePlayButton();
});

audio.addEventListener("ended", () => {
  if (state.playMode === "single") {
    audio.currentTime = 0;
    void audio.play().catch(() => undefined);
    return;
  }
  skip(1);
});

boot();
