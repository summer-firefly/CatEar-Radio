import { invoke, addPluginListener, type PluginListener } from "@tauri-apps/api/core";

export type OsMediaHandlers = {
  play: () => void;
  pause: () => void;
  stop: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
  /** Relative seek for headset / lock-screen rewind & forward buttons. */
  seekBy: (delta: number) => void;
};

export type OsMediaTrack = {
  title: string;
  artist: string;
  album?: string;
  artworkUrl?: string | null;
};

type NativeMediaState = {
  title?: string;
  artist?: string;
  album?: string;
  artworkUrl?: string;
  duration?: number;
  position?: number;
  playbackSpeed?: number;
  isPlaying?: boolean;
  canPrev?: boolean;
  canNext?: boolean;
  canSeek?: boolean;
};

type NativeMediaActionEvent = {
  action: "play" | "pause" | "stop" | "next" | "previous" | "seek";
  seekPosition?: number;
};

let handlers: OsMediaHandlers | null = null;
let webReady = false;
let nativeListener: PluginListener | null = null;
let nativeReady = false;
let lastNativeKey = "";
/** Mirrors the player's speed so lock screens show a sane progress timeline. */
let playbackRate = 1;
/** Whether prev/next actually do something for the current queue. */
let canPrev = true;
let canNext = true;

function preferHttps(url: string): string {
  if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`;
  return url;
}

function hasWebMediaSession(): boolean {
  return typeof navigator !== "undefined" && "mediaSession" in navigator;
}

function isAndroidHost(): boolean {
  return (
    document.documentElement.classList.contains("is-android") ||
    /android/i.test(navigator.userAgent || "")
  );
}

type WebAction = [MediaSessionAction, MediaSessionActionHandler | null];

/**
 * Absolute seek actions share one shape; the OS also offers relative
 * rewind/forward (headset double-click, lock screen ±15s).
 */
function relativeSeek(details: MediaSessionActionDetails, fallback: number) {
  const offset = typeof details.seekOffset === "number" ? details.seekOffset : fallback;
  if (!Number.isFinite(offset)) return;
  handlers?.seekBy(offset);
}

function applyWebActionHandlers() {
  if (!hasWebMediaSession() || !handlers) return;
  const ms = navigator.mediaSession;

  const seekto: MediaSessionActionHandler = (details) => {
    if (details.seekTime != null) handlers?.seek(details.seekTime);
  };
  const backward: MediaSessionActionHandler = (details) => relativeSeek(details, -15);
  const forward: MediaSessionActionHandler = (details) => relativeSeek(details, 15);

  const map: WebAction[] = [
    ["play", () => handlers?.play()],
    ["pause", () => handlers?.pause()],
    ["stop", () => handlers?.stop()],
    ["previoustrack", canPrev ? () => handlers?.previous() : null],
    ["nexttrack", canNext ? () => handlers?.next() : null],
    ["seekto", seekto],
    ["seekbackward", backward],
    ["seekforward", forward],
  ];
  for (const [action, fn] of map) {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      // Some WebViews reject unsupported actions.
    }
  }
  webReady = true;
}

async function ensureNativeListener() {
  if (!isAndroidHost() || nativeListener || !handlers) return;
  try {
    nativeListener = await addPluginListener<NativeMediaActionEvent>(
      "media-session",
      "media_action",
      (event) => {
        if (!handlers) return;
        switch (event.action) {
          case "play":
            handlers.play();
            break;
          case "pause":
            handlers.pause();
            break;
          case "stop":
            handlers.stop();
            break;
          case "next":
            handlers.next();
            break;
          case "previous":
            handlers.previous();
            break;
          case "seek":
            if (typeof event.seekPosition === "number") handlers.seek(event.seekPosition);
            break;
        }
      },
    );
    nativeReady = true;
  } catch (e) {
    console.warn("native media-session listener failed", e);
  }
}

async function nativeUpdateState(state: NativeMediaState) {
  if (!isAndroidHost()) return;
  try {
    await invoke("plugin:media-session|update_state", state);
    nativeReady = true;
  } catch (e) {
    console.warn("native media-session update_state failed", e);
  }
}

async function nativeUpdateTimeline(position: number, duration: number) {
  if (!isAndroidHost() || !nativeReady) return;
  try {
    await invoke("plugin:media-session|update_timeline", { position, duration });
  } catch {
    /* ignore frequent timeline failures */
  }
}

export async function initOsMediaControls(next: OsMediaHandlers) {
  handlers = next;
  applyWebActionHandlers();
  await ensureNativeListener();
}

export async function syncOsMediaTrack(
  track: OsMediaTrack | null,
  playing: boolean,
  position: number,
  duration: number,
) {
  if (!track) {
    if (hasWebMediaSession()) {
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = "none";
      } catch {
        /* ignore */
      }
    }
    if (isAndroidHost() && nativeReady) {
      try {
        await invoke("plugin:media-session|clear");
      } catch {
        /* ignore */
      }
      lastNativeKey = "";
    }
    return;
  }

  const artwork = track.artworkUrl?.trim() ? preferHttps(track.artworkUrl.trim()) : "";
  if (hasWebMediaSession()) {
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || "未知歌曲",
        artist: track.artist || "未知歌手",
        album: track.album || "",
        artwork: artwork
          ? [
              { src: artwork, sizes: "96x96", type: "image/jpeg" },
              { src: artwork, sizes: "256x256", type: "image/jpeg" },
              { src: artwork, sizes: "512x512", type: "image/jpeg" },
            ]
          : [],
      });
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
      if (Number.isFinite(duration) && duration > 0) {
        navigator.mediaSession.setPositionState?.({
          duration,
          playbackRate,
          position: Math.min(Math.max(0, position), duration),
        });
      }
    } catch (e) {
      console.warn("web mediaSession sync failed", e);
    }
  }

  const key = `${track.title}|${track.artist}|${artwork}|${playing}`;
  if (key !== lastNativeKey) {
    lastNativeKey = key;
    await nativeUpdateState({
      title: track.title || "未知歌曲",
      artist: track.artist || "未知歌手",
      album: track.album || "",
      artworkUrl: artwork || undefined,
      duration: Number.isFinite(duration) ? duration : 0,
      position: Number.isFinite(position) ? position : 0,
      playbackSpeed: playbackRate,
      isPlaying: playing,
      canPrev,
      canNext,
      canSeek: true,
    });
  } else {
    await nativeUpdateState({
      isPlaying: playing,
      position: Number.isFinite(position) ? position : 0,
      duration: Number.isFinite(duration) ? duration : 0,
    });
  }
}

export function syncOsMediaPlaybackState(playing: boolean) {
  if (hasWebMediaSession()) {
    try {
      navigator.mediaSession.playbackState = playing ? "playing" : "paused";
    } catch {
      /* ignore */
    }
  }
  if (isAndroidHost() && nativeReady) {
    void nativeUpdateState({ isPlaying: playing });
  }
}

export function syncOsMediaPosition(position: number, duration: number) {
  if (hasWebMediaSession()) {
    try {
      if (Number.isFinite(duration) && duration > 0) {
        navigator.mediaSession.setPositionState?.({
          duration,
          playbackRate,
          position: Math.min(Math.max(0, position), duration),
        });
      }
    } catch {
      /* ignore */
    }
  }
  void nativeUpdateTimeline(position, duration);
}

/** Keep the OS timeline in step with the player's speed (0.75×–2×). */
export function syncOsMediaPlaybackRate(rate: number, position = 0, duration = 0) {
  const next = Number.isFinite(rate) && rate > 0 ? rate : 1;
  if (next === playbackRate) return;
  playbackRate = next;
  if (hasWebMediaSession() && Number.isFinite(duration) && duration > 0) {
    try {
      navigator.mediaSession.setPositionState?.({
        duration,
        playbackRate,
        position: Math.min(Math.max(0, position), duration),
      });
    } catch {
      /* ignore */
    }
  }
  if (isAndroidHost() && nativeReady) {
    void invoke("plugin:media-session|update_timeline", { playbackSpeed: playbackRate }).catch(
      () => undefined,
    );
  }
}

/**
 * Queue-aware prev/next availability — lock screens otherwise offer buttons
 * that silently do nothing for single-track or single-mode playback.
 */
export function syncOsMediaSkipAvailability(prev: boolean, next: boolean) {
  if (prev === canPrev && next === canNext) return;
  canPrev = prev;
  canNext = next;
  applyWebActionHandlers();
  if (isAndroidHost() && nativeReady) {
    void nativeUpdateState({ canPrev, canNext });
  }
}

export function isOsMediaWebReady() {
  return webReady;
}
