export type HardwareAcceleration =
  "None" | "Nvenc" | "Qsv" | "Vaapi" | "Amf" | "VideoToolbox";

export type VideoCodec = "H264" | "Hevc";

export type VaapiDriver = "Default" | "iHD" | "i965" | "RadeonSI" | "Nouveau";

/** Voice-over detail for TV episodes. */
export const SHOW_VOICE_DETAILS = [
  "show",
  "show_episode",
  "show_season_episode",
  "show_season_name",
  "show_season_episode_name",
] as const;

export type ShowVoiceDetail = (typeof SHOW_VOICE_DETAILS)[number];

export const SHOW_VOICE_DETAIL_LABELS: Record<ShowVoiceDetail, string> = {
  show: "Show name only",
  show_episode: "Show + episode name",
  show_season_episode: "Show + season + episode",
  show_season_name: "Show + season + episode name",
  show_season_episode_name: "Show + season + episode + episode name",
};

export function isShowVoiceDetail(value: unknown): value is ShowVoiceDetail {
  return (
    typeof value === "string" &&
    (SHOW_VOICE_DETAILS as readonly string[]).includes(value)
  );
}

/** TTS engine preference. `auto` tries Piper → Edge → Windows SAPI. */
export const VOICE_PROVIDERS = ["auto", "piper", "edge", "sapi"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];

export const VOICE_PROVIDER_LABELS: Record<VoiceProvider, string> = {
  auto: "Auto (Piper → Edge → SAPI)",
  piper: "Piper (Wyoming) only",
  edge: "Edge TTS only",
  sapi: "Windows SAPI only",
};

export function isVoiceProvider(value: unknown): value is VoiceProvider {
  return (
    typeof value === "string" &&
    (VOICE_PROVIDERS as readonly string[]).includes(value)
  );
}

/** Number of next-items featured in a promo (duration = count × 10s). */
export const PROMO_ITEM_COUNTS = [1, 2, 3] as const;
export type PromoItemCount = (typeof PROMO_ITEM_COUNTS)[number];

export function isPromoItemCount(value: unknown): value is PromoItemCount {
  return value === 1 || value === 2 || value === 3;
}

/** How promos are delivered to ErsatzTV fillers. */
export const PROMO_DELIVERY_MODES = ["file", "remote-stream"] as const;
export type PromoDeliveryMode = (typeof PROMO_DELIVERY_MODES)[number];

export const PROMO_DELIVERY_MODE_LABELS: Record<PromoDeliveryMode, string> = {
  file: "File (baked MP4)",
  "remote-stream": "Remote Stream (live encode)",
};

export function isPromoDeliveryMode(
  value: unknown,
): value is PromoDeliveryMode {
  return (
    typeof value === "string" &&
    (PROMO_DELIVERY_MODES as readonly string[]).includes(value)
  );
}

export interface AppSettings {
  etvUrl: string;
  etvApiKey: string;
  etvDatabase: string;
  libraryPath: string;
  etvPathPrefix: string;
  outputPath: string;
  etvLibraryPath: string;
  /**
   * Base URL ErsatzTV uses to reach this app for live promos
   * (e.g. http://tv-promo-generator:5174). Used in Remote Stream YAML.
   */
  etvOnDemandBaseUrl: string;
  /**
   * `file` — bake next-items.mp4 and push as Other Video.
   * `remote-stream` — write YAML + live MPEG-TS encode on play.
   */
  promoDeliveryMode: PromoDeliveryMode;
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
  /**
   * When true, lower-third bar stays left and spans nearly the full frame width.
   * When false (default), the bar tracks the focused 50% panel as items change.
   */
  lowerThirdFullWidth: boolean;
  /**
   * How many upcoming items to feature in the promo (1 → 10s, 2 → 20s, 3 → 30s).
   */
  promoItemCount: PromoItemCount;
  /** How much episode detail to speak after the show name (movies stay title-only). */
  showVoiceDetail: ShowVoiceDetail;
  /** Which TTS engine(s) to use. */
  voiceProvider: VoiceProvider;
  /** Wyoming Piper base URL (e.g. http://192.168.0.151:10200). */
  piperUrl: string;
  /** Default Piper voice when no language-specific override is set. */
  piperVoice: string;
  /** Per-language Piper voice overrides (keys are channel language codes, e.g. en, uk). */
  piperVoiceByLanguage: Record<string, string>;
  /** Optional default Piper speaker id. */
  piperSpeaker: string;
  /** Per-language Piper speaker overrides. */
  piperSpeakerByLanguage: Record<string, string>;
  /** Silence between cue and title (ms). */
  voicePauseMs: number;
  /** Per synthesis attempt timeout (ms). */
  ttsTimeoutMs: number;
  /**
   * Volume of original clip audio in the promo (0–100).
   * 0 = skip/mute source audio (voice-over only when enabled).
   */
  sourceAudioVolume: number;
  /**
   * When true and sourceAudioVolume > 0, keep original audio muted until
   * each item's voice-over finishes (stays in sync with the video window).
   */
  sourceAudioAfterVoice: boolean;
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

export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "late";

/** Languages with voice/overlay templates (canonical codes). */
export const CHANNEL_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "it", label: "Italian" },
  { code: "pt", label: "Portuguese" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "uk", label: "Ukrainian" },
  { code: "ja", label: "Japanese" },
  { code: "zh", label: "Chinese" },
  { code: "ko", label: "Korean" },
] as const;

export type ChannelLanguageCode = (typeof CHANNEL_LANGUAGES)[number]["code"];

export type JobKind =
  "generate" | "vo-prewarm" | "push" | "rollback" | "live-stream";

export type JobLogLevel = "info" | "warn" | "error";

/** Classic-schedule filler slots we can wire on push. */
export const FILLER_PLACEMENTS = ["pre", "middle", "post", "tail"] as const;
export type FillerPlacement = (typeof FILLER_PLACEMENTS)[number];

export const FILLER_PLACEMENT_LABELS: Record<FillerPlacement, string> = {
  pre: "Pre",
  middle: "Middle",
  post: "Post",
  tail: "Tail",
};

export function isFillerPlacement(value: unknown): value is FillerPlacement {
  return (
    typeof value === "string" &&
    (FILLER_PLACEMENTS as readonly string[]).includes(value)
  );
}

/** Options for Push to ErsatzTV (from the push modal). */
export interface PushOptions {
  fillerTypes: FillerPlacement[];
  /** Remove untyped legacy promo fillers (`Promo Generator - Next - {channel}`). */
  cleanupLegacy: boolean;
  /**
   * Clear typed promo fillers for slots that are not selected, and delete those
   * presets when unused. With zero selected types, removes all typed promo fillers.
   */
  cleanupUnselected: boolean;
}

export function isPushOptionsActionable(options: PushOptions): boolean {
  return (
    options.fillerTypes.length > 0 ||
    options.cleanupLegacy ||
    options.cleanupUnselected
  );
}

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
  /** Set for push jobs. */
  pushOptions?: PushOptions;
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
  /** True when a baked preview MP4 exists on disk (manual Generate). */
  promoExists: boolean;
  /** Baked MP4 URL for download/legacy preview, if present. */
  promoUrl?: string;
  /**
   * Live MPEG-TS for the Channels page (`/live/{number}/promo.ts`).
   * Prefer this over promoUrl in the UI. Same URL ETV uses.
   */
  livePromoUrl?: string;
  lastError?: string;
  lastGeneratedAt?: string;
}

export interface PushChannelResult {
  channelNumber: string;
  channelName: string;
  ok: boolean;
  message: string;
  /** Human-readable notes about fillers set/cleared on the schedule. */
  scheduleNotes?: string;
}

export interface EtvBackupInfo {
  id: string;
  createdAt: string;
  sourcePath: string;
  path: string;
  bytes: number;
  reason: "manual" | "pre-push";
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
  etvUrl: "http://localhost:8409",
  etvApiKey: "",
  etvDatabase: "",
  libraryPath: "",
  etvPathPrefix: "",
  outputPath: "./output",
  etvLibraryPath: "",
  etvOnDemandBaseUrl: "",
  promoDeliveryMode: "remote-stream",
  cachePath: "./cache",
  configPath: "./config",
  port: 5174,
  hardwareAcceleration: "None",
  vaapiDevice: "/dev/dri/renderD128",
  vaapiDriver: "Default",
  vaapiDisplay: "drm",
  videoCodec: "H264",
  videoBitrate: 4000,
  audioBitrate: 192,
  resolution: "1920x1080",
  videoPreset: "medium",
  videoProfile: "high",
  voiceEnabled: true,
  regenLeadMinutes: 3,
  timeZone: "",
  lowerThirdFullWidth: false,
  promoItemCount: 3,
  showVoiceDetail: "show_season_episode_name",
  voiceProvider: "auto",
  piperUrl: "",
  piperVoice: "",
  piperVoiceByLanguage: {},
  piperSpeaker: "",
  piperSpeakerByLanguage: {},
  voicePauseMs: 450,
  ttsTimeoutMs: 20_000,
  sourceAudioVolume: 0,
  sourceAudioAfterVoice: true,
};

export function parseResolution(resolution: string): {
  width: number;
  height: number;
} {
  const match = /^(\d+)x(\d+)$/i.exec(resolution.trim());
  if (!match) {
    return { width: 1920, height: 1080 };
  }

  return { width: Number(match[1]), height: Number(match[2]) };
}

export function sanitizeChannelFolderName(name: string): string {
  return (
    name
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "channel"
  );
}
