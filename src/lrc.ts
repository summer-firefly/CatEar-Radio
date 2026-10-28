export type LyricLine = { time: number; text: string };

function parseTimestamp(min: string, sec: string, frac?: string): number {
  const m = Number(min) || 0;
  const s = Number(sec) || 0;
  const f = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
  return m * 60 + s + f / 1000;
}

/** Split space-/slash-joined Chinese phrases into one display line each. */
function expandPhraseText(text: string): string[] {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return [];

  if (/[\/|｜／]/.test(t)) {
    const parts = t
      .split(/[\/|｜／]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length > 1) return parts;
  }

  if (!/\s/.test(t) || !/[\u4e00-\u9fff]/.test(t)) return [t];

  const parts = t.split(/\s+/).filter(Boolean);
  if (parts.length < 2) return [t];

  // Only split when chunks look like Chinese lyric phrases, not English sentences.
  const cjkHeavy = parts.filter((p) => {
    const cjk = (p.match(/[\u4e00-\u9fff]/g) || []).length;
    return cjk > 0 && cjk >= Math.ceil(p.length * 0.45);
  });
  if (cjkHeavy.length < 2) return [t];

  return parts;
}

/** Timed LRC rows before phrase expansion. */
function parseRawTimedLines(raw: string): LyricLine[] {
  const normalized = raw
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const lines: LyricLine[] = [];
  const segmentRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]([^\[]*)/g;

  for (const line of normalized.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || /^\[offset:/i.test(trimmed)) continue;

    const segments: { time: number; text: string }[] = [];
    for (const m of trimmed.matchAll(segmentRe)) {
      segments.push({
        time: parseTimestamp(m[1], m[2], m[3]),
        text: (m[4] || "").replace(/\s+/g, " ").trim(),
      });
    }
    if (!segments.length) continue;

    // `[t1][t2]text` → both times share text; `[t1]a [t2]b` → interleaved.
    let pending: number[] = [];
    for (const seg of segments) {
      if (!seg.text) {
        pending.push(seg.time);
        continue;
      }
      for (const time of pending) lines.push({ time, text: seg.text });
      pending = [];
      lines.push({ time: seg.time, text: seg.text });
    }
  }

  return lines.sort((a, b) => a.time - b.time);
}

/** One Chinese phrase per row; spread times across the gap to the next stamp. */
function expandTimedPhrases(raw: LyricLine[]): LyricLine[] {
  const out: LyricLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const phrases = expandPhraseText(raw[i].text);
    if (phrases.length <= 1) {
      out.push({ time: raw[i].time, text: phrases[0] || raw[i].text });
      continue;
    }
    const start = raw[i].time;
    const nextTime = raw[i + 1]?.time;
    const span =
      nextTime != null && nextTime > start
        ? nextTime - start
        : Math.max(phrases.length * 1.8, 2);
    phrases.forEach((phrase, j) => {
      out.push({
        time: start + (span * j) / phrases.length,
        text: phrase,
      });
    });
  }
  return out;
}

/**
 * Parse LRC into timed lines.
 * Handles classic `[t]text`, multi-tag `[t1][t2]text`, and inline `[t1]a [t2]b`.
 * Chinese phrases joined by spaces become separate display lines.
 */
export function parseLrc(raw?: string | null): LyricLine[] {
  if (!raw) return [];
  return expandTimedPhrases(parseRawTimedLines(raw));
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
