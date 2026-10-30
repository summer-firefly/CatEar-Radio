import { invoke, addPluginListener, type PluginListener } from "@tauri-apps/api/core";

export type OsMediaHandlers = {
  play: () => void;
  pause: () => void;
  stop: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
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

function applyWebActionHandlers() {
  if (!hasWebMediaSession() || !handlers) return;
  const ms = navigator.mediaSession;
  const map: Array<[MediaSessionAction, () => void]> = [
    ["play", () => handlers?.play()],
    ["pause", () => handlers?.pause()],
    ["stop", () => handlers?.stop()],
    ["previoustrack", () => handlers?.previous()],
    ["nexttrack", () => handlers?.next()],
    [
      "seekto",
      () => {
        /* handled below with details */
      },
    ],
  ];
  for (const [action, fn] of map) {
    try {
      if (action === "seekto") {
        ms.setActionHandler("seekto", (details) => {
          if (details.seekTime != null) handlers?.seek(details.seekTime);
        });
      } else {
        ms.setActionHandler(action, fn);
      }
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
          playbackRate: 1,
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
      isPlaying: playing,
      canPrev: true,
      canNext: true,
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
          playbackRate: 1,
          position: Math.min(Math.max(0, position), duration),
        });
      }
    } catch {
      /* ignore */
    }
  }
  void nativeUpdateTimeline(position, duration);
}

export function isOsMediaWebReady() {
  return webReady;
}
