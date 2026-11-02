import { emit, listen } from "@tauri-apps/api/event";
import "./lyrics.css";

type LyricLine = { time: number; text: string; translation?: string };

/** Payload pushed by the main window; `lyrics` is omitted when it is unchanged. */
interface LyricsPayload {
  uid: string;
  title: string;
  artist: string;
  lyrics: LyricLine[] | null;
  position: number;
  playing: boolean;
  theme: "dark" | "light";
  offset: number;
}

const root = document.querySelector<HTMLDivElement>("#app")!;

let uid = "";
let title = "";
let artist = "";
let lyrics: LyricLine[] = [];
let offset = 0;
let playing = false;
/** Playback clock sampled at `baseAt` (ms) — the overlay interpolates between pushes. */
let basePosition = 0;
let baseAt = 0;
/** Last painted line index; `-2` = idle placeholder, `null` = force a repaint. */
let lastIdx: number | null = null;

function applyTheme(theme: "dark" | "light") {
  document.documentElement.dataset.theme = theme;
}

function positionNow(): number {
  if (!playing) return basePosition;
  return basePosition + (performance.now() - baseAt) / 1000;
}

function activeIndex(t: number): number {
  if (!lyrics.length) return -1;
  const at = t - offset;
  for (let i = 0; i < lyrics.length; i++) {
    const next = lyrics[i + 1];
    if (at >= lyrics[i].time && (!next || at < next.time)) return i;
  }
  if (at < lyrics[0].time) return -1;
  return lyrics.length - 1;
}

/**
 * The overlay never calls app commands itself — it only asks the main window
 * to show, hide, or lock it, so the ACL stays minimal.
 */
function sendAction(action: "lock" | "close") {
  void emit("desktop-lyrics-action", action);
}

function render() {
  root.innerHTML = `
    <div class="lyric-window" data-tauri-drag-region="deep">
      <div class="lyric-tools">
        <button type="button" id="lock" title="锁定（鼠标穿透，可从托盘解锁）">🔒</button>
        <button type="button" id="close" title="关闭桌面歌词">✕</button>
      </div>
      <div class="lyric-current" id="current"></div>
      <div class="lyric-tr" id="translation"></div>
      <div class="lyric-next" id="next"></div>
    </div>
  `;
  root.querySelector("#lock")?.addEventListener("click", () => sendAction("lock"));
  root.querySelector("#close")?.addEventListener("click", () => sendAction("close"));
  paint();
}

function paint() {
  const current = root.querySelector<HTMLElement>("#current");
  const next = root.querySelector<HTMLElement>("#next");
  const translation = root.querySelector<HTMLElement>("#translation");
  if (!current || !next || !translation) return;

  if (!uid) {
    if (lastIdx !== -2) {
      current.textContent = "猫耳收音机";
      next.textContent = "未在播放";
      translation.textContent = "";
      lastIdx = -2;
    }
    return;
  }
  const idx = activeIndex(positionNow());
  if (idx === lastIdx) return;
  lastIdx = idx;

  const line = idx >= 0 ? lyrics[idx] : undefined;
  current.textContent = line?.text || title || "♪";
  next.textContent = (idx >= 0 ? lyrics[idx + 1]?.text : lyrics[0]?.text) || artist;
  translation.textContent = line?.translation || "";
}

function apply(payload: LyricsPayload) {
  applyTheme(payload.theme);
  offset = payload.offset;
  playing = payload.playing;
  basePosition = payload.position;
  baseAt = performance.now();

  const trackChanged = payload.uid !== uid;
  uid = payload.uid;
  title = payload.title;
  artist = payload.artist;
  if (payload.lyrics) lyrics = payload.lyrics;
  if (trackChanged) lastIdx = null;

  document.title = title ? `${title} — 桌面歌词` : "桌面歌词";
  paint();
}

function loop() {
  paint();
  requestAnimationFrame(loop);
}

async function boot() {
  render();
  requestAnimationFrame(loop);
  try {
    await listen<LyricsPayload>("desktop-lyrics-state", (event) => apply(event.payload));
  } catch (e) {
    console.error(e);
  }
  // The overlay can be shown long after playback started — ask for a snapshot.
  void emit("desktop-lyrics-ready").catch(() => undefined);
}

void boot();
