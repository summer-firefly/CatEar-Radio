import type { LyricLine, LyricWord } from "./types";

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

/**
 * NetEase word-level rows: `[start,duration](start,dur,flag)word…`.
 * Milliseconds, no separators between words.
 */
function parseWordLines(raw: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const row of raw.split("\n")) {
    const line = row.trim();
    const head = /^\[(\d+),(\d+)\](.*)$/.exec(line);
    if (!head) continue;

    const words: LyricWord[] = [];
    let text = "";
    for (const m of head[3].matchAll(/\((\d+),(\d+),\d+\)([^(]*)/g)) {
      const piece = m[3];
      if (!piece) continue;
      const time = Number(m[1]) / 1000;
      words.push({ time, end: time + Number(m[2]) / 1000, text: piece });
      text += piece;
    }

    const trimmed = text.trim();
    if (!trimmed || !words.length) continue;
    out.push({ time: Number(head[1]) / 1000, text: trimmed, words });
  }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * Split one timed row into one row per phrase, cutting at word boundaries when
 * karaoke timings exist. Returns null when the phrase text does not line up with
 * the words, so callers can fall back instead of guessing at timings.
 */
function splitByWords(line: LyricLine, phrases: string[]): LyricLine[] | null {
  const words = line.words;
  if (!words?.length) return null;

  // Character offsets are whitespace-insensitive: word text and the joined line
  // text can differ only in spacing.
  const bounds: number[] = [];
  let acc = 0;
  for (const w of words) bounds.push((acc += w.text.replace(/\s+/g, "").length));

  const rows: LyricLine[] = [];
  let from = 0;
  let budget = 0;
  for (const phrase of phrases) {
    budget += phrase.replace(/\s+/g, "").length;
    let to = from;
    while (to < bounds.length && bounds[to] !== budget) to++;
    // The phrase end must land exactly on a word end, or karaoke would drift.
    if (to >= bounds.length) return null;
    // Drop whitespace-only pieces so a row never starts with a stray gap.
    const chunk = words.slice(from, to + 1).filter((w) => w.text.trim() !== "");
    if (chunk.length) rows.push({ time: chunk[0].time, text: phrase, words: chunk });
    from = to + 1;
  }
  return from === words.length ? rows : null;
}

/** One Chinese phrase per row; spread times across the gap to the next stamp. */
function splitPhrases(lines: LyricLine[]): LyricLine[] {
  const out: LyricLine[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const phrases = expandPhraseText(line.text);
    if (phrases.length <= 1) {
      out.push({ ...line, text: phrases[0] || line.text });
      continue;
    }

    const start = line.time;
    const nextTime = lines[i + 1]?.time;
    const span =
      nextTime != null && nextTime > start
        ? nextTime - start
        : Math.max(phrases.length * 1.8, 2);

    const timed = splitByWords(line, phrases);
    if (timed) {
      if (line.translation) timed[0].translation = line.translation;
      out.push(...timed);
      continue;
    }

    phrases.forEach((phrase, j) => {
      const row: LyricLine = { time: start + (span * j) / phrases.length, text: phrase };
      // A translation covers the whole source row — keep it on the first only.
      if (j === 0 && line.translation) row.translation = line.translation;
      out.push(row);
    });
  }
  return out;
}

/** Attach same-timestamp rows (translations, word timings) onto the main lines. */
function attachTimed(
  lines: LyricLine[],
  source: LyricLine[],
  tolerance: number,
  apply: (line: LyricLine, src: LyricLine) => void,
) {
  let j = 0;
  for (const line of lines) {
    while (j < source.length && source[j].time < line.time - tolerance) j++;
    if (j >= source.length) break;
    if (Math.abs(source[j].time - line.time) <= tolerance) {
      apply(line, source[j]);
      j++;
    }
  }
}

/**
 * Parse LRC into timed lines.
 * Handles classic `[t]text`, multi-tag `[t1][t2]text`, inline `[t1]a [t2]b`,
 * bilingual translations, and word-level (karaoke) timings.
 * Chinese phrases joined by spaces become separate display lines; karaoke word
 * timings are cut at the same boundaries so highlighting stays in sync.
 */
export function parseLrc(
  raw?: string | null,
  extra?: { translation?: string | null; words?: string | null },
): LyricLine[] {
  if (!raw) return [];
  const base = parseRawTimedLines(raw);
  if (!base.length) return [];

  const translations = extra?.translation ? parseRawTimedLines(extra.translation) : [];
  const wordLines = extra?.words ? parseWordLines(extra.words) : [];

  if (translations.length) {
    attachTimed(base, translations, 0.35, (line, src) => {
      const text = src.text.trim();
      // Keep rows that already carry the original as the translation slot only.
      if (text && text !== line.text) line.translation = text;
    });
  }
  if (wordLines.length) {
    attachTimed(base, wordLines, 0.3, (line, src) => {
      if (!src.words?.length) return;
      line.words = src.words;
      // Word text is the authoritative rendering — it may differ in spacing.
      line.text = src.text;
    });
  }

  return splitPhrases(base);
}

export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
