import fs from 'node:fs';
import path from 'node:path';
import {
  AppSettings,
  CHANNEL_LANGUAGES,
  ChannelOverrides,
  DEFAULT_SETTINGS,
  HardwareAcceleration,
  isPromoItemCount,
  isShowVoiceDetail,
  isVoiceProvider,
  ShowVoiceDetail,
  VaapiDriver,
  VideoCodec,
  VoiceProvider,
} from '@promo/shared';
import { loadEnv } from './env.js';

const SETTINGS_FILE = 'settings.json';
const CHANNELS_FILE = 'channels.json';

/** Older settings.json fields before piperVoiceByLanguage. */
type LegacyVoiceFields = {
  piperVoiceEn?: string;
  piperVoiceUk?: string;
};

loadEnv();

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function envInt(name: string): number | undefined {
  const value = env(name);
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function envBool(name: string): boolean | undefined {
  const value = env(name);
  if (!value) return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Prefer UI/file value, then env bootstrap, then default. */
function pick<T>(fileVal: T | undefined, envVal: T | undefined, fallback: T): T {
  return fileVal !== undefined ? fileVal : envVal !== undefined ? envVal : fallback;
}

function cleanLangMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const code = key.trim().toLowerCase();
    if (!code || typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) out[code] = trimmed;
  }
  return out;
}

/** Env map for PIPER_VOICE_<LANG>, then file map (and legacy en/uk fields) wins. */
function resolvePiperVoiceByLanguage(fromFile: Partial<AppSettings> & LegacyVoiceFields): Record<string, string> {
  const fromEnv: Record<string, string> = {};
  for (const lang of CHANNEL_LANGUAGES) {
    const value = env(`PIPER_VOICE_${lang.code.toUpperCase()}`);
    if (value) fromEnv[lang.code] = value;
  }

  const fromLegacy: Record<string, string> = {};
  if (fromFile.piperVoiceEn?.trim()) fromLegacy.en = fromFile.piperVoiceEn.trim();
  if (fromFile.piperVoiceUk?.trim()) fromLegacy.uk = fromFile.piperVoiceUk.trim();

  const fromMap = cleanLangMap(fromFile.piperVoiceByLanguage);

  // defaults < env < legacy file fields < file map
  return { ...fromEnv, ...fromLegacy, ...fromMap };
}

/** Env map for PIPER_SPEAKER_<LANG>, then file map wins. */
function resolvePiperSpeakerByLanguage(fromFile: Partial<AppSettings>): Record<string, string> {
  const fromEnv: Record<string, string> = {};
  for (const lang of CHANNEL_LANGUAGES) {
    const value = env(`PIPER_SPEAKER_${lang.code.toUpperCase()}`);
    if (value) fromEnv[lang.code] = value;
  }
  return { ...fromEnv, ...cleanLangMap(fromFile.piperSpeakerByLanguage) };
}

export function resolveConfigPath(): string {
  return path.resolve(env('CONFIG_PATH') ?? DEFAULT_SETTINGS.configPath);
}

export function loadSettings(): AppSettings {
  const configPath = resolveConfigPath();
  ensureDir(configPath);
  const filePath = path.join(configPath, SETTINGS_FILE);
  let fromFile: Partial<AppSettings> & LegacyVoiceFields = {};
  if (fs.existsSync(filePath)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<AppSettings> & LegacyVoiceFields;
    } catch {
      fromFile = {};
    }
  }

  // Precedence: defaults < env (Docker bootstrap) < settings.json (UI).
  // CONFIG_PATH is infrastructure and always comes from the environment.
  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    configPath,
    etvUrl: pick(fromFile.etvUrl, env('ETV_URL'), DEFAULT_SETTINGS.etvUrl),
    etvApiKey: pick(fromFile.etvApiKey, env('ETV_API_KEY'), DEFAULT_SETTINGS.etvApiKey),
    etvDatabase: pick(fromFile.etvDatabase, env('ETV_DATABASE'), DEFAULT_SETTINGS.etvDatabase),
    libraryPath: pick(fromFile.libraryPath, env('LIBRARY_PATH'), DEFAULT_SETTINGS.libraryPath),
    etvPathPrefix: pick(fromFile.etvPathPrefix, env('ETV_PATH_PREFIX'), DEFAULT_SETTINGS.etvPathPrefix),
    outputPath: path.resolve(
      pick(fromFile.outputPath, env('OUTPUT_PATH'), DEFAULT_SETTINGS.outputPath),
    ),
    etvLibraryPath: pick(fromFile.etvLibraryPath, env('ETV_LIBRARY_PATH'), DEFAULT_SETTINGS.etvLibraryPath),
    cachePath: path.resolve(
      pick(fromFile.cachePath, env('CACHE_PATH'), DEFAULT_SETTINGS.cachePath),
    ),
    port: pick(fromFile.port, envInt('PORT'), DEFAULT_SETTINGS.port),
    hardwareAcceleration: pick(
      fromFile.hardwareAcceleration,
      env('HARDWARE_ACCELERATION') as HardwareAcceleration | undefined,
      DEFAULT_SETTINGS.hardwareAcceleration,
    ),
    vaapiDevice: pick(fromFile.vaapiDevice, env('VAAPI_DEVICE'), DEFAULT_SETTINGS.vaapiDevice),
    vaapiDriver: pick(
      fromFile.vaapiDriver,
      env('VAAPI_DRIVER') as VaapiDriver | undefined,
      DEFAULT_SETTINGS.vaapiDriver,
    ),
    vaapiDisplay: pick(fromFile.vaapiDisplay, env('VAAPI_DISPLAY'), DEFAULT_SETTINGS.vaapiDisplay),
    videoCodec: pick(
      fromFile.videoCodec,
      env('VIDEO_CODEC') as VideoCodec | undefined,
      DEFAULT_SETTINGS.videoCodec,
    ),
    videoBitrate: pick(fromFile.videoBitrate, envInt('VIDEO_BITRATE'), DEFAULT_SETTINGS.videoBitrate),
    audioBitrate: pick(fromFile.audioBitrate, envInt('AUDIO_BITRATE'), DEFAULT_SETTINGS.audioBitrate),
    resolution: pick(fromFile.resolution, env('RESOLUTION'), DEFAULT_SETTINGS.resolution),
    videoPreset: pick(fromFile.videoPreset, env('VIDEO_PRESET'), DEFAULT_SETTINGS.videoPreset),
    videoProfile: pick(fromFile.videoProfile, env('VIDEO_PROFILE'), DEFAULT_SETTINGS.videoProfile),
    voiceEnabled: pick(fromFile.voiceEnabled, envBool('VOICE_ENABLED'), DEFAULT_SETTINGS.voiceEnabled),
    regenLeadMinutes: pick(
      fromFile.regenLeadMinutes,
      envInt('REGEN_LEAD_MINUTES'),
      DEFAULT_SETTINGS.regenLeadMinutes,
    ),
    timeZone: pick(fromFile.timeZone, env('TIME_ZONE') ?? env('TZ'), DEFAULT_SETTINGS.timeZone),
    lowerThirdFullWidth: pick(
      fromFile.lowerThirdFullWidth,
      envBool('LOWER_THIRD_FULL_WIDTH'),
      DEFAULT_SETTINGS.lowerThirdFullWidth,
    ),
    promoItemCount: pick(
      isPromoItemCount(fromFile.promoItemCount) ? fromFile.promoItemCount : undefined,
      (() => {
        const raw = envInt('PROMO_ITEM_COUNT');
        return isPromoItemCount(raw) ? raw : undefined;
      })(),
      DEFAULT_SETTINGS.promoItemCount,
    ),
    showVoiceDetail: pick(
      isShowVoiceDetail(fromFile.showVoiceDetail) ? fromFile.showVoiceDetail : undefined,
      (() => {
        const raw = env('SHOW_VOICE_DETAIL');
        return isShowVoiceDetail(raw) ? (raw as ShowVoiceDetail) : undefined;
      })(),
      DEFAULT_SETTINGS.showVoiceDetail,
    ),
    voiceProvider: pick(
      isVoiceProvider(fromFile.voiceProvider) ? fromFile.voiceProvider : undefined,
      (() => {
        const raw = env('VOICE_PROVIDER');
        return isVoiceProvider(raw) ? (raw as VoiceProvider) : undefined;
      })(),
      DEFAULT_SETTINGS.voiceProvider,
    ),
    piperUrl: pick(
      fromFile.piperUrl,
      env('PIPER_URL') ?? env('WYOMING_PIPER_URL'),
      DEFAULT_SETTINGS.piperUrl,
    ),
    piperVoice: pick(fromFile.piperVoice, env('PIPER_VOICE'), DEFAULT_SETTINGS.piperVoice),
    piperVoiceByLanguage: resolvePiperVoiceByLanguage(fromFile),
    piperSpeaker: pick(fromFile.piperSpeaker, env('PIPER_SPEAKER'), DEFAULT_SETTINGS.piperSpeaker),
    piperSpeakerByLanguage: resolvePiperSpeakerByLanguage(fromFile),
    voicePauseMs: pick(fromFile.voicePauseMs, envInt('VOICE_PAUSE_MS'), DEFAULT_SETTINGS.voicePauseMs),
    ttsTimeoutMs: pick(fromFile.ttsTimeoutMs, envInt('TTS_TIMEOUT_MS'), DEFAULT_SETTINGS.ttsTimeoutMs),
    sourceAudioVolume: pick(
      fromFile.sourceAudioVolume,
      envInt('SOURCE_AUDIO_VOLUME'),
      DEFAULT_SETTINGS.sourceAudioVolume,
    ),
    sourceAudioAfterVoice: pick(
      fromFile.sourceAudioAfterVoice,
      envBool('SOURCE_AUDIO_AFTER_VOICE'),
      DEFAULT_SETTINGS.sourceAudioAfterVoice,
    ),
  };

  if (!Number.isFinite(merged.sourceAudioVolume)) {
    merged.sourceAudioVolume = DEFAULT_SETTINGS.sourceAudioVolume;
  } else {
    merged.sourceAudioVolume = Math.max(0, Math.min(100, Math.round(merged.sourceAudioVolume)));
  }

  if (!merged.etvLibraryPath) {
    merged.etvLibraryPath = merged.outputPath;
  }

  ensureDir(merged.outputPath);
  ensureDir(merged.cachePath);
  return merged;
}

export function saveSettings(settings: AppSettings): AppSettings {
  const configPath = resolveConfigPath();
  ensureDir(configPath);
  const sourceAudioVolume = Number.isFinite(settings.sourceAudioVolume)
    ? Math.max(0, Math.min(100, Math.round(settings.sourceAudioVolume)))
    : DEFAULT_SETTINGS.sourceAudioVolume;
  const toStore: AppSettings = {
    ...settings,
    sourceAudioVolume,
    configPath,
    outputPath: path.resolve(settings.outputPath),
    cachePath: path.resolve(settings.cachePath),
  };
  fs.writeFileSync(path.join(configPath, SETTINGS_FILE), JSON.stringify(toStore, null, 2), 'utf8');
  ensureDir(toStore.outputPath);
  ensureDir(toStore.cachePath);
  return loadSettings();
}

/** Delete UI-persisted settings so the next load uses env → defaults. */
export function clearSavedSettings(): AppSettings {
  const filePath = path.join(resolveConfigPath(), SETTINGS_FILE);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  return loadSettings();
}

export function hasSavedSettings(): boolean {
  return fs.existsSync(path.join(resolveConfigPath(), SETTINGS_FILE));
}

export function loadChannelOverrides(): ChannelOverrides {
  const configPath = resolveConfigPath();
  ensureDir(configPath);
  const filePath = path.join(configPath, CHANNELS_FILE);
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ChannelOverrides;
  } catch {
    return {};
  }
}

export function saveChannelOverrides(overrides: ChannelOverrides): ChannelOverrides {
  const configPath = resolveConfigPath();
  ensureDir(configPath);
  fs.writeFileSync(path.join(configPath, CHANNELS_FILE), JSON.stringify(overrides, null, 2), 'utf8');
  return overrides;
}

export function updateChannelOverride(
  channelNumber: string,
  patch: Partial<ChannelOverrides[string]>,
): ChannelOverrides {
  const overrides = loadChannelOverrides();
  overrides[channelNumber] = {
    ...overrides[channelNumber],
    ...patch,
    enabled: patch.enabled ?? overrides[channelNumber]?.enabled ?? true,
  };
  return saveChannelOverrides(overrides);
}
