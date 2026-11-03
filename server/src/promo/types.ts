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

export type PromoProgress = (message: string, level?: 'info' | 'warn' | 'error') => void;

export interface PromoRenderRequest {
  channelName: string;
  channelNumber: string;
  language: string;
  color: string;
  logoPath?: string;
  chapters: PromoChapterSource[];
  outputFile: string;
  workDir: string;
  fontFile: string;
  voiceEnabled: boolean;
  cachePath: string;
  onProgress?: PromoProgress;
}
