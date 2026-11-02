export interface PromoChapterSource {
  filePath: string;
  durationSeconds: number;
  hasAudio?: boolean;
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
