export type HardwareAcceleration =
  | 'None'
  | 'Nvenc'
  | 'Qsv'
  | 'Vaapi'
  | 'Amf'
  | 'VideoToolbox';

export type VideoCodec = 'H264' | 'Hevc';

export type VaapiDriver = 'Default' | 'iHD' | 'i965' | 'RadeonSI' | 'Nouveau';

export interface AppSettings {
  etvUrl: string;
  etvApiKey: string;
  etvDatabase: string;
  libraryPath: string;
  etvPathPrefix: string;
  outputPath: string;
  etvLibraryPath: string;
  cachePath: string;
  configPath: string;
  port: number;
  hardwareAcceleration: HardwareAcceleration;
  vaapiDevice: string;
  vaapiDriver: VaapiDriver;
  vaapiDisplay: string;
  videoCodec: VideoCodec;
  videoBitrate: number;
  audioBitrate: number;
  resolution: string;
  videoPreset: string;
  videoProfile: string;
  voiceEnabled: boolean;
  regenLeadMinutes: number;
  /** IANA timezone for on-screen / VO start times (e.g. America/New_York). Empty = process default. */
  timeZone: string;
}

export interface ChannelOverride {
  enabled: boolean;
  language?: string;
  color?: string;
  colorLocked?: boolean;
}

export interface ChannelOverrides {
  [channelNumber: string]: ChannelOverride;
}

export interface ScheduleItemPreview {
  mediaItemId: number;
  title: string;
  episodeTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  start: string;
  finish: string;
  filePath?: string;
  durationSeconds?: number;
  error?: string;
}

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'late';

export type JobKind = 'generate' | 'push' | 'rollback';

export type JobLogLevel = 'info' | 'warn' | 'error';

export interface JobLogEntry {
  at: string;
  level: JobLogLevel;
  message: string;
}

export interface JobInfo {
  id: string;
  kind: JobKind;
  channelNumber: string;
  channelName: string;
  status: JobStatus;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  deadline?: string;
  error?: string;
  late?: boolean;
  /** Set for rollback jobs — ErsatzTV backup id to restore. */
  backupId?: string;
  logs: JobLogEntry[];
}

export interface ChannelView {
  number: string;
  name: string;
  tvgId: string;
  logoUrl?: string;
  language: string;
  color: string;
  colorLocked: boolean;
  enabled: boolean;
  nextItems: ScheduleItemPreview[];
  currentItem?: ScheduleItemPreview;
  nextRegenAt?: string;
  promoExists: boolean;
  promoUrl?: string;
  lastError?: string;
  lastGeneratedAt?: string;
}

export interface PushChannelResult {
  channelNumber: string;
  channelName: string;
  ok: boolean;
  message: string;
  replacedPreRoll?: string;
}

export interface EtvBackupInfo {
  id: string;
  createdAt: string;
  sourcePath: string;
  path: string;
  bytes: number;
  reason: 'manual' | 'pre-push';
}

export interface PushResult {
  results: PushChannelResult[];
  backup?: EtvBackupInfo;
}

export interface SettingsCheck {
  id: string;
  label: string;
  ok: boolean;
  message: string;
}

export interface ValidateSettingsResult {
  ok: boolean;
  checks: SettingsCheck[];
}

export interface RollbackResult {
  ok: boolean;
  backup: EtvBackupInfo;
  message: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  etvUrl: 'http://localhost:8409',
  etvApiKey: '',
  etvDatabase: '',
  libraryPath: '',
  etvPathPrefix: '',
  outputPath: './output',
  etvLibraryPath: '',
  cachePath: './cache',
  configPath: './config',
  port: 5174,
  hardwareAcceleration: 'None',
  vaapiDevice: '/dev/dri/renderD128',
  vaapiDriver: 'Default',
  vaapiDisplay: 'drm',
  videoCodec: 'H264',
  videoBitrate: 4000,
  audioBitrate: 192,
  resolution: '1920x1080',
  videoPreset: 'medium',
  videoProfile: 'high',
  voiceEnabled: true,
  regenLeadMinutes: 3,
  timeZone: '',
};

export function parseResolution(resolution: string): { width: number; height: number } {
  const match = /^(\d+)x(\d+)$/i.exec(resolution.trim());
  if (!match) {
    return { width: 1920, height: 1080 };
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

export function sanitizeChannelFolderName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'channel';
}
