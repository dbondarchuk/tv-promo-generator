import { spawn } from 'node:child_process';
import { resolveFfmpegBinaries } from './binaries.js';

function runFfprobe(args: string[]): Promise<string> {
  const { ffprobe } = resolveFfmpegBinaries();
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobe, args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err || `ffprobe exited ${code}`));
        return;
      }
      resolve(out.trim());
    });
  });
}

export async function probeDurationSeconds(filePath: string): Promise<number> {
  const out = await runFfprobe([
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const n = Number(out);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid duration for ${filePath}: ${out}`);
  }
  return n;
}

export async function probeHasAudio(filePath: string): Promise<boolean> {
  try {
    const streams = await probeAudioStreams(filePath);
    return streams.length > 0;
  } catch {
    return false;
  }
}

export interface AudioStreamInfo {
  /** Index among audio streams only (ffmpeg `a:N`). */
  audioIndex: number;
  language?: string;
  title?: string;
  isDefault: boolean;
}

/** ISO 639-1 channel codes → common stream tag variants (639-1 / 639-2 / aliases). */
const AUDIO_LANG_ALIASES: Record<string, string[]> = {
  en: ['en', 'eng'],
  es: ['es', 'spa', 'esl', 'esp'],
  fr: ['fr', 'fra', 'fre'],
  de: ['de', 'deu', 'ger'],
  it: ['it', 'ita'],
  pt: ['pt', 'por'],
  nl: ['nl', 'nld', 'dut'],
  pl: ['pl', 'pol'],
  ru: ['ru', 'rus'],
  uk: ['uk', 'ukr', 'ua'],
  ja: ['ja', 'jpn'],
  zh: ['zh', 'zho', 'chi', 'cmn', 'yue'],
  ko: ['ko', 'kor'],
};

function normalizeStreamLanguage(tag?: string): string {
  if (!tag) return '';
  return tag.trim().toLowerCase().replace(/_/g, '-').split('-')[0] ?? '';
}

export function audioStreamMatchesLanguage(streamLang: string | undefined, channelLanguage: string): boolean {
  const stream = normalizeStreamLanguage(streamLang);
  if (!stream) return false;
  const want = channelLanguage.trim().toLowerCase().replace(/_/g, '-').split('-')[0] || 'en';
  const aliases = AUDIO_LANG_ALIASES[want] ?? [want];
  if (aliases.includes(stream)) return true;
  for (const [code, als] of Object.entries(AUDIO_LANG_ALIASES)) {
    if (als.includes(stream) && code === want) return true;
  }
  return stream === want;
}

export async function probeAudioStreams(filePath: string): Promise<AudioStreamInfo[]> {
  const out = await runFfprobe([
    '-v', 'error',
    '-select_streams', 'a',
    '-show_entries', 'stream=index:stream_tags=language,title:stream_disposition=default',
    '-of', 'json',
    filePath,
  ]);
  const parsed = JSON.parse(out) as {
    streams?: Array<{
      index?: number;
      tags?: { language?: string; title?: string };
      disposition?: { default?: number | string };
    }>;
  };
  const streams = parsed.streams ?? [];
  return streams.map((s, audioIndex) => ({
    audioIndex,
    language: s.tags?.language,
    title: s.tags?.title,
    isDefault: Number(s.disposition?.default ?? 0) === 1,
  }));
}

/** Prefer language match, then default disposition, then first audio stream. */
export function pickAudioStreamForLanguage(
  streams: AudioStreamInfo[],
  channelLanguage: string,
): AudioStreamInfo | undefined {
  if (streams.length === 0) return undefined;
  const matched = streams.find((s) => audioStreamMatchesLanguage(s.language, channelLanguage));
  if (matched) return matched;
  return streams.find((s) => s.isDefault) ?? streams[0];
}

export function pickRandomWindows(duration: number, count: number, windowSeconds: number): number[] {
  if (duration <= windowSeconds + 1) {
    return Array.from({ length: count }, () => 0);
  }
  const margin = Math.max(0, duration * 0.05);
  const usableStart = margin;
  const usableEnd = Math.max(usableStart + windowSeconds, duration - margin);
  const usable = Math.max(0, usableEnd - usableStart - windowSeconds);
  if (usable <= 0) {
    return Array.from({ length: count }, () => usableStart);
  }

  const starts: number[] = [];
  const attempts = count * 20;
  for (let i = 0; i < attempts && starts.length < count; i++) {
    const candidate = usableStart + Math.random() * usable;
    const overlaps = starts.some((s) => Math.abs(s - candidate) < windowSeconds);
    if (!overlaps) starts.push(candidate);
  }
  while (starts.length < count) {
    starts.push(usableStart + Math.random() * usable);
  }
  return starts.sort((a, b) => a - b);
}
