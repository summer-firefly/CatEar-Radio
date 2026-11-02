/**
 * WebAudio equalizer sitting between the audio element and the speakers.
 *
 * `createMediaElementSource` permanently reroutes an element, and on a CDN that
 * refuses CORS it would turn a working player into a silent one. So the graph is
 * only built after the user turns the EQ on *and* the current stream has been
 * probed successfully.
 */

export const EQ_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000];

export interface EqPreset {
  id: string;
  label: string;
  /** One gain in dB per band in `EQ_BANDS`. */
  gains: number[];
}

export const EQ_PRESETS: EqPreset[] = [
  { id: "flat", label: "原声", gains: [0, 0, 0, 0, 0, 0, 0, 0] },
  { id: "pop", label: "流行", gains: [-1, 1, 3, 4, 2, -1, -1, -2] },
  { id: "rock", label: "摇滚", gains: [4, 3, 1, -1, -1, 1, 3, 4] },
  { id: "vocal", label: "人声", gains: [-3, -1, 1, 3, 4, 3, 1, -2] },
  { id: "bass", label: "低音", gains: [7, 5, 3, 1, 0, 0, 0, 0] },
  { id: "treble", label: "高音", gains: [0, 0, 0, 0, 1, 3, 5, 6] },
];

export const EQ_GAIN_RANGE = 12;

let ctx: AudioContext | null = null;
let preamp: GainNode | null = null;
let analyser: AnalyserNode | null = null;
let filters: BiquadFilterNode[] = [];
let attached: HTMLAudioElement | null = null;
let gains: number[] = EQ_BANDS.map(() => 0);
let preampDb = 0;

/** Latest time-domain samples of the graph output. */
const probe = new Uint8Array(32);

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Ask the CDN whether the stream may be piped through WebAudio.
 *
 * Cross-origin media without `Access-Control-Allow-Origin` produces silence
 * once routed through a graph, and that cannot be undone — so checking first is
 * the only way to keep the failure recoverable.
 */
export async function canProcess(url: string): Promise<boolean> {
  if (/^(blob:|asset:|data:)/i.test(url) || url.includes("asset.localhost")) return true;
  try {
    const res = await fetch(url, { method: "GET", headers: { Range: "bytes=0-1" } });
    // Any readable response means CORS passed; opaque responses do not exist
    // for `cors` mode, so reaching here is already a success signal.
    return res.ok || res.status === 206;
  } catch {
    return false;
  }
}

/**
 * Build the graph for `el` and route playback through it.
 *
 * Returns an error string when the runtime has no WebAudio.
 */
export function attach(el: HTMLAudioElement): string | null {
  if (ctx) {
    void ctx.resume().catch(() => undefined);
    return null;
  }

  const Ctor: typeof AudioContext | undefined =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return "当前环境不支持 WebAudio 均衡器";

  let created: AudioContext;
  try {
    created = new Ctor();
  } catch {
    return "无法创建音频处理上下文";
  }

  let node: MediaElementAudioSourceNode;
  try {
    node = created.createMediaElementSource(el);
  } catch {
    void created.close().catch(() => undefined);
    return "该音频无法接入均衡器";
  }

  const chainPreamp = created.createGain();
  chainPreamp.gain.value = dbToGain(preampDb);
  const chainFilters = EQ_BANDS.map((freq, i) => {
    const filter = created.createBiquadFilter();
    filter.type = "peaking";
    filter.frequency.value = freq;
    filter.Q.value = 1.1;
    filter.gain.value = gains[i] ?? 0;
    return filter;
  });
  const chainAnalyser = created.createAnalyser();
  chainAnalyser.fftSize = probe.length * 2;

  node.connect(chainPreamp);
  let head: AudioNode = chainPreamp;
  for (const filter of chainFilters) {
    head.connect(filter);
    head = filter;
  }
  head.connect(chainAnalyser);
  chainAnalyser.connect(created.destination);

  ctx = created;
  preamp = chainPreamp;
  filters = chainFilters;
  analyser = chainAnalyser;
  attached = el;
  void ctx.resume().catch(() => undefined);
  return null;
}

export function setGains(next: number[]) {
  gains = EQ_BANDS.map((_, i) => Math.max(-EQ_GAIN_RANGE, Math.min(EQ_GAIN_RANGE, next[i] ?? 0)));
  filters.forEach((filter, i) => {
    filter.gain.value = gains[i] ?? 0;
  });
}

export function getGains(): number[] {
  return [...gains];
}

export function setPreamp(db: number) {
  preampDb = Math.max(-EQ_GAIN_RANGE, Math.min(EQ_GAIN_RANGE, db));
  if (preamp) preamp.gain.value = dbToGain(preampDb);
}

/** Output RMS in 0..1, or -1 before the graph exists. */
export function outputLevel(): number {
  if (!analyser) return -1;
  analyser.getByteTimeDomainData(probe);
  let sum = 0;
  for (const v of probe) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return Math.sqrt(sum / probe.length);
}

export function isAttached(): boolean {
  return !!attached;
}
