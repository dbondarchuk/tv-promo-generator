import {
  AppSettings,
  ChannelOverrides,
  DEFAULT_SETTINGS,
  isPromoItemCount,
  isShowVoiceDetail,
  isVoiceProvider,
} from "@promo/shared";
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./env.js";

const SETTINGS_FILE = "settings.json";
const CHANNELS_FILE = "channels.json";

/** Older settings.json fields before piperVoiceByLanguage. */
type LegacyVoiceFields = {
  piperVoiceEn?: string;
  piperVoiceUk?: string;
};

loadEnv();

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function envInt(name: string): number | undefined {
  const value = env(name);
  if (!value) return undefined;

  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function cleanLangMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const code = key.trim().toLowerCase();
    if (!code || typeof value !== "string") continue;

    const trimmed = value.trim();
    if (trimmed) out[code] = trimmed;
  }

  return out;
}

function resolvePiperVoiceByLanguage(
  fromFile: Partial<AppSettings> & LegacyVoiceFields,
): Record<string, string> {
  const fromLegacy: Record<string, string> = {};
  if (fromFile.piperVoiceEn?.trim())
    fromLegacy.en = fromFile.piperVoiceEn.trim();

  if (fromFile.piperVoiceUk?.trim())
    fromLegacy.uk = fromFile.piperVoiceUk.trim();

  return { ...fromLegacy, ...cleanLangMap(fromFile.piperVoiceByLanguage) };
}

function resolvePiperSpeakerByLanguage(
  fromFile: Partial<AppSettings>,
): Record<string, string> {
  return cleanLangMap(fromFile.piperSpeakerByLanguage);
}

export function resolveConfigPath(): string {
  return path.resolve(env("CONFIG_PATH") ?? DEFAULT_SETTINGS.configPath);
}

function settingsFilePath(): string {
  return path.join(resolveConfigPath(), SETTINGS_FILE);
}

/** Infra / process settings — always from env (not the Settings UI). */
function infraFromEnv(): Pick<
  AppSettings,
  "port" | "cachePath" | "configPath"
> {
  return {
    configPath: resolveConfigPath(),
    port: envInt("PORT") ?? DEFAULT_SETTINGS.port,
    cachePath: path.resolve(env("CACHE_PATH") ?? DEFAULT_SETTINGS.cachePath),
  };
}

/**
 * One-time seed helpers: if an old .env still has app keys when settings.json is
 * first created, copy them in so upgrades don't lose config. After the file exists,
 * only the UI/file values are used (except infra + TIME_ZONE fallback).
 */
function bootstrapAppFromEnv(): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  const str = (key: keyof AppSettings, envName: string) => {
    const v = env(envName);
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  };

  const num = (key: keyof AppSettings, envName: string) => {
    const v = envInt(envName);
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  };

  str("etvUrl", "ETV_URL");
  str("etvApiKey", "ETV_API_KEY");
  str("etvDatabase", "ETV_DATABASE");
  str("libraryPath", "LIBRARY_PATH");
  str("etvPathPrefix", "ETV_PATH_PREFIX");
  str("outputPath", "OUTPUT_PATH");
  str("etvLibraryPath", "ETV_LIBRARY_PATH");
  str("hardwareAcceleration", "HARDWARE_ACCELERATION");
  str("vaapiDevice", "VAAPI_DEVICE");
  str("vaapiDriver", "VAAPI_DRIVER");
  str("vaapiDisplay", "VAAPI_DISPLAY");
  str("videoCodec", "VIDEO_CODEC");
  num("videoBitrate", "VIDEO_BITRATE");
  num("audioBitrate", "AUDIO_BITRATE");
  str("resolution", "RESOLUTION");
  str("videoPreset", "VIDEO_PRESET");
  str("videoProfile", "VIDEO_PROFILE");
  str("piperUrl", "PIPER_URL");
  if (!out.piperUrl) str("piperUrl", "WYOMING_PIPER_URL");
  str("piperVoice", "PIPER_VOICE");
  str("piperSpeaker", "PIPER_SPEAKER");
  num("voicePauseMs", "VOICE_PAUSE_MS");
  num("ttsTimeoutMs", "TTS_TIMEOUT_MS");
  num("regenLeadMinutes", "REGEN_LEAD_MINUTES");
  num("sourceAudioVolume", "SOURCE_AUDIO_VOLUME");
  str("timeZone", "TIME_ZONE");
  if (!out.timeZone) str("timeZone", "TZ");

  const voiceEnabled = env("VOICE_ENABLED");
  if (voiceEnabled !== undefined) {
    out.voiceEnabled = ["1", "true", "yes", "on"].includes(
      voiceEnabled.toLowerCase(),
    );
  }

  const afterVoice = env("SOURCE_AUDIO_AFTER_VOICE");
  if (afterVoice !== undefined) {
    out.sourceAudioAfterVoice = ["1", "true", "yes", "on"].includes(
      afterVoice.toLowerCase(),
    );
  }

  const fullWidth = env("LOWER_THIRD_FULL_WIDTH");
  if (fullWidth !== undefined) {
    out.lowerThirdFullWidth = ["1", "true", "yes", "on"].includes(
      fullWidth.toLowerCase(),
    );
  }

  const itemCount = envInt("PROMO_ITEM_COUNT");
  if (isPromoItemCount(itemCount)) out.promoItemCount = itemCount;
  const showDetail = env("SHOW_VOICE_DETAIL");
  if (isShowVoiceDetail(showDetail)) out.showVoiceDetail = showDetail;
  const provider = env("VOICE_PROVIDER");
  if (isVoiceProvider(provider)) out.voiceProvider = provider;

  return out;
}

function normalizeSettings(
  fromFile: Partial<AppSettings> & LegacyVoiceFields,
): AppSettings {
  const infra = infraFromEnv();
  const fileTimeZone =
    typeof fromFile.timeZone === "string" ? fromFile.timeZone.trim() : "";

  const timeZone =
    fileTimeZone || env("TIME_ZONE") || env("TZ") || DEFAULT_SETTINGS.timeZone;

  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...fromFile,
    ...infra,
    timeZone,
    piperVoiceByLanguage: resolvePiperVoiceByLanguage(fromFile),
    piperSpeakerByLanguage: resolvePiperSpeakerByLanguage(fromFile),
    outputPath: path.resolve(
      fromFile.outputPath || DEFAULT_SETTINGS.outputPath,
    ),
  };

  if (!isPromoItemCount(merged.promoItemCount)) {
    merged.promoItemCount = DEFAULT_SETTINGS.promoItemCount;
  }

  if (!isShowVoiceDetail(merged.showVoiceDetail)) {
    merged.showVoiceDetail = DEFAULT_SETTINGS.showVoiceDetail;
  }

  if (!isVoiceProvider(merged.voiceProvider)) {
    merged.voiceProvider = DEFAULT_SETTINGS.voiceProvider;
  }

  if (!Number.isFinite(merged.sourceAudioVolume)) {
    merged.sourceAudioVolume = DEFAULT_SETTINGS.sourceAudioVolume;
  } else {
    merged.sourceAudioVolume = Math.max(
      0,
      Math.min(100, Math.round(merged.sourceAudioVolume)),
    );
  }

  if (!merged.etvLibraryPath?.trim()) {
    merged.etvLibraryPath = merged.outputPath;
  }

  return merged;
}

/** Write settings.json (app fields only; infra always re-applied on load). */
function writeSettingsFile(settings: AppSettings): void {
  const configPath = resolveConfigPath();
  ensureDir(configPath);
  const {
    port: _port,
    cachePath: _cachePath,
    configPath: _configPath,
    ...appFields
  } = settings;

  const toStore = {
    ...appFields,
    outputPath: path.resolve(settings.outputPath),
    sourceAudioVolume: Number.isFinite(settings.sourceAudioVolume)
      ? Math.max(0, Math.min(100, Math.round(settings.sourceAudioVolume)))
      : DEFAULT_SETTINGS.sourceAudioVolume,
  };

  fs.writeFileSync(
    path.join(configPath, SETTINGS_FILE),
    JSON.stringify(toStore, null, 2),
    "utf8",
  );
}

function ensureSettingsFile(): Partial<AppSettings> & LegacyVoiceFields {
  const configPath = resolveConfigPath();
  ensureDir(configPath);
  const filePath = settingsFilePath();
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(
        fs.readFileSync(filePath, "utf8"),
      ) as Partial<AppSettings> & LegacyVoiceFields;
    } catch {
      // Corrupt file — fall through and rewrite from defaults.
    }
  }

  const seeded = normalizeSettings({
    ...DEFAULT_SETTINGS,
    ...bootstrapAppFromEnv(),
  });

  writeSettingsFile(seeded);
  return seeded;
}

/** True when enough ErsatzTV / path settings exist to run the app. */
export function isAppConfigured(settings: AppSettings): boolean {
  return Boolean(
    settings.etvUrl?.trim() &&
    settings.etvDatabase?.trim() &&
    settings.libraryPath?.trim() &&
    settings.outputPath?.trim(),
  );
}

export function loadSettings(): AppSettings {
  const fromFile = ensureSettingsFile();
  const merged = normalizeSettings(fromFile);
  ensureDir(merged.outputPath);
  ensureDir(merged.cachePath);
  return merged;
}

export function saveSettings(settings: AppSettings): AppSettings {
  const infra = infraFromEnv();
  const normalized = normalizeSettings({
    ...settings,
    ...infra,
  });

  writeSettingsFile(normalized);
  ensureDir(normalized.outputPath);
  ensureDir(normalized.cachePath);
  return loadSettings();
}

/** Reset settings.json to built-in defaults (plus one-time env bootstrap). */
export function clearSavedSettings(): AppSettings {
  const filePath = settingsFilePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }

  return loadSettings();
}

export function hasSettingsFile(): boolean {
  return fs.existsSync(settingsFilePath());
}

/** @deprecated Use hasSettingsFile — settings.json is always created on load. */
export function hasSavedSettings(): boolean {
  return hasSettingsFile();
}

export function loadChannelOverrides(): ChannelOverrides {
  const configPath = resolveConfigPath();
  ensureDir(configPath);
  const filePath = path.join(configPath, CHANNELS_FILE);
  if (!fs.existsSync(filePath)) return {};

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as ChannelOverrides;
  } catch {
    return {};
  }
}

export function saveChannelOverrides(
  overrides: ChannelOverrides,
): ChannelOverrides {
  const configPath = resolveConfigPath();
  ensureDir(configPath);
  fs.writeFileSync(
    path.join(configPath, CHANNELS_FILE),
    JSON.stringify(overrides, null, 2),
    "utf8",
  );

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
