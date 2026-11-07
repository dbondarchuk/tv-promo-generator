/** Parse ffmpeg `-stats` / stderr progress lines into a compact job-log line. */

export interface FfmpegProgressSnapshot {
  frame?: number;
  fps?: number;
  time?: string;
  speed?: number;
  size?: string;
  bitrate?: string;
}

const PROGRESS_RE =
  /(?:frame=\s*(\d+)\s+)?(?:fps=\s*([\d.]+)\s+)?(?:.*?size=\s*(\S+)\s+)?(?:time=\s*([\d:.]+)\s+)?(?:bitrate=\s*(\S+)\s+)?(?:.*?speed=\s*([\d.]+)x)?/i;

export function parseFfmpegProgressChunk(
  chunk: string,
): FfmpegProgressSnapshot | null {
  // ffmpeg rewrites the same line with \r; take the last complete-ish segment.
  const parts = chunk
    .split(/\r|\n/)
    .filter((p) => p.includes("time=") || p.includes("speed="));

  const line = parts[parts.length - 1];
  if (!line) return null;

  const m = line.match(PROGRESS_RE);
  if (!m) return null;

  const frame = m[1] ? Number(m[1]) : undefined;
  const fps = m[2] ? Number(m[2]) : undefined;
  const size = m[3];
  const time = m[4];
  const bitrate = m[5];
  const speed = m[6] ? Number(m[6]) : undefined;

  if (time == null && speed == null && frame == null) return null;

  return {
    frame: Number.isFinite(frame) ? frame : undefined,
    fps: Number.isFinite(fps) ? fps : undefined,
    size,
    time,
    bitrate,
    speed: Number.isFinite(speed) ? speed : undefined,
  };
}

export function formatFfmpegProgress(snap: FfmpegProgressSnapshot): string {
  const bits: string[] = ["ffmpeg"];
  if (snap.time) bits.push(`t=${snap.time}`);
  if (snap.fps != null)
    bits.push(`${snap.fps.toFixed(snap.fps >= 10 ? 0 : 1)} fps`);

  if (snap.speed != null) bits.push(`${snap.speed.toFixed(2)}x`);
  if (snap.frame != null) bits.push(`frame ${snap.frame}`);
  if (snap.bitrate && snap.bitrate !== "N/A") bits.push(snap.bitrate);
  return bits.join(" · ");
}

/**
 * Accumulate stderr chunks and emit throttled progress lines.
 * Returns a `push` handler for raw stderr data.
 */
export function createFfmpegProgressReporter(
  onProgress: (message: string) => void,
  opts?: { intervalMs?: number },
): (data: Buffer | string) => void {
  const intervalMs = opts?.intervalMs ?? 2_000;
  let lastEmit = 0;
  let buf = "";

  return (data: Buffer | string) => {
    buf += typeof data === "string" ? data : data.toString("utf8");
    // Keep a trailing window; progress lines are rewritten with \r.
    if (buf.length > 8_000) buf = buf.slice(-4_000);

    const now = Date.now();
    if (now - lastEmit < intervalMs) return;

    const snap = parseFfmpegProgressChunk(buf);
    if (!snap) return;

    lastEmit = now;
    onProgress(formatFfmpegProgress(snap));
  };
}
