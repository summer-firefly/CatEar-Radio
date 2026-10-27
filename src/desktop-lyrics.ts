import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import "./desktop-lyrics.css";

type ResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

type DesktopLyricPayload = {
  line: string;
  next: string;
  title: string;
  artist: string;
};

const FONT_KEY = "maoer-dl-font";
const NEXT_KEY = "maoer-dl-show-next";
const FONT_STEPS = [26, 30, 34, 40, 48, 56];

const win = getCurrentWindow();
const rootEl = document.querySelector<HTMLElement>("#dl-root")!;
const lineEl = document.querySelector<HTMLElement>("#dl-line")!;
const nextEl = document.querySelector<HTMLElement>("#dl-next")!;
const nextBtn = document.querySelector<HTMLElement>("#btn-toggle-next");

function loadPrefs() {
  const font = Number(localStorage.getItem(FONT_KEY) || "34");
  const showNext = localStorage.getItem(NEXT_KEY) !== "0";
  applyFont(font, false);
  rootEl.classList.toggle("hide-next", !showNext);
  syncNextBtn();
}

function applyFont(px: number, resizeWindow: boolean) {
  const clamped = FONT_STEPS.includes(px)
    ? px
    : FONT_STEPS.reduce((a, b) => (Math.abs(b - px) < Math.abs(a - px) ? b : a));
  localStorage.setItem(FONT_KEY, String(clamped));
  rootEl.style.setProperty("--dl-line", `${clamped}px`);
  rootEl.style.setProperty("--dl-next", `${Math.max(13, Math.round(clamped * 0.46))}px`);
  if (resizeWindow) void fitWindowToFont(clamped);
}

async function fitWindowToFont(fontPx: number) {
  try {
    const size = await win.innerSize();
    const factor = await win.scaleFactor();
    const logicalW = size.width / factor;
    const nextVisible = showNextEnabled();
    const logicalH = Math.max(108, Math.round(fontPx * (nextVisible ? 2.55 : 1.7) + 56));
    await win.setSize(new LogicalSize(Math.max(360, logicalW), logicalH));
  } catch {
    // ignore
  }
}

async function scaleWindow(factor: number) {
  try {
    const size = await win.innerSize();
    const scale = await win.scaleFactor();
    const w = Math.max(360, Math.round((size.width / scale) * factor));
    const h = Math.max(108, Math.round((size.height / scale) * factor));
    await win.setSize(new LogicalSize(w, h));
  } catch {
    // ignore
  }
}

function currentFont(): number {
  return Number(localStorage.getItem(FONT_KEY) || "34");
}

function showNextEnabled(): boolean {
  return localStorage.getItem(NEXT_KEY) !== "0";
}

function syncNextBtn() {
  nextBtn?.classList.toggle("is-on", showNextEnabled());
  nextBtn?.setAttribute("title", showNextEnabled() ? "隐藏下一句" : "显示下一句");
}

function showChrome() {
  rootEl.classList.add("show-chrome");
}

function hideChrome() {
  rootEl.classList.remove("show-chrome");
}

function applyPayload(p: DesktopLyricPayload) {
  const line = (p.line || "").trim() || p.title || "暂无歌词";
  const next = (p.next || "").trim() || (p.line ? "" : p.artist || "");
  if (lineEl.textContent !== line) {
    lineEl.classList.remove("swap");
    void lineEl.offsetWidth;
    lineEl.textContent = line;
    lineEl.classList.add("swap");
  }
  nextEl.textContent = next;
  nextEl.style.opacity = next ? "1" : "0";
}

const RESIZE_MAP: Record<string, ResizeDirection> = {
  North: "North",
  South: "South",
  East: "East",
  West: "West",
  NorthEast: "NorthEast",
  NorthWest: "NorthWest",
  SouthEast: "SouthEast",
  SouthWest: "SouthWest",
};

async function boot() {
  loadPrefs();

  document.addEventListener("contextmenu", (e) => {
    e.preventDefault();
  });

  rootEl.addEventListener("mouseenter", () => showChrome());
  rootEl.addEventListener("mouseleave", () => hideChrome());
  rootEl.addEventListener("click", () => showChrome());

  rootEl.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if ((e.target as Element | null)?.closest?.(".dl-tool")) return;
    void win.startDragging();
  });

  rootEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-act]");
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === "close") {
      void win.close();
      return;
    }
    if (act === "font-up") {
      const i = FONT_STEPS.indexOf(currentFont());
      applyFont(FONT_STEPS[Math.min(FONT_STEPS.length - 1, Math.max(0, i) + 1)], true);
    } else if (act === "font-down") {
      const i = FONT_STEPS.indexOf(currentFont());
      applyFont(FONT_STEPS[Math.max(0, (i < 0 ? 2 : i) - 1)], true);
    } else if (act === "win-up") {
      void scaleWindow(1.15);
    } else if (act === "win-down") {
      void scaleWindow(1 / 1.15);
    } else if (act === "toggle-next") {
      const next = !showNextEnabled();
      localStorage.setItem(NEXT_KEY, next ? "1" : "0");
      rootEl.classList.toggle("hide-next", !next);
      syncNextBtn();
      void fitWindowToFont(currentFont());
    }
  });

  document.querySelectorAll<HTMLElement>("[data-resize]").forEach((edge) => {
    edge.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const dir = RESIZE_MAP[edge.dataset.resize || ""];
      if (!dir) return;
      void win.startResizeDragging(dir);
    });
  });

  await listen<DesktopLyricPayload>("desktop-lyrics-sync", (event) => {
    applyPayload(event.payload);
  });

  await emit("desktop-lyrics-ready");
}

void boot();
