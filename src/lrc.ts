export type LyricLine = { time: number; text: string };

export function parseLrc(raw?: string | null): LyricLine[] {
  if (!raw) return [];
  const lines: LyricLine[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const matches = [...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:\.(\d{1,3}))?]/g)];
    if (!matches.length) continue;
    const text = line.replace(/\[\d{1,2}:\d{1,2}(?:\.\d{1,3})?\]/g, "").trim();
    if (!text) continue;
    for (const m of matches) {
      const min = Number(m[1]) || 0;
      const sec = Number(m[2]) || 0;
      const frac = m[3] ? Number(m[3].padEnd(3, "0").slice(0, 3)) : 0;
      lines.push({ time: min * 60 + sec + frac / 1000, text });
    }
  }
  return lines.sort((a, b) => a.time - b.time);
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
