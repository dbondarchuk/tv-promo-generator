export interface PromoChapterSource {
  filePath: string;
  durationSeconds: number;
  hasAudio?: boolean;
  /** Audio stream index among audio tracks (`a:N`) matching channel language when known. */
  audioStreamIndex?: number;
  /** Language tag of the selected audio stream, if any. */
  audioStreamLanguage?: string;
  title: string;
  episodeTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  startLabel: string;
}

export type PromoProgress = (
  message: string,
  level?: "info" | "warn" | "error",
) => void;

/**
 * synthesize — run TTS (file generate path).
 * cache-only — use warm WAVs only; skip VO entirely if any item is cold (live air).
 * off — never attach VO.
 */
export type PromoVoiceMode = "synthesize" | "cache-only" | "off";

export interface PromoRenderRequest {
  channelName: string;
  channelNumber: string;
  language: string;
  color: string;
  logoPath?: string;
  chapters: PromoChapterSource[];
  /** Required for file encode; unused for live MPEG-TS. */
  outputFile?: string;
  workDir: string;
  fontFile: string;
  voiceEnabled: boolean;
  /** Defaults to synthesize when voiceEnabled. */
  voiceMode?: PromoVoiceMode;
  cachePath: string;
  onProgress?: PromoProgress;
}
