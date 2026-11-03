import fs from 'node:fs';
import path from 'node:path';
import {
  AppSettings,
  ChannelOverrides,
  DEFAULT_SETTINGS,
  HardwareAcceleration,
  VaapiDriver,
  VideoCodec,
} from '@promo/shared';
import { loadEnv } from './env.js';

const SETTINGS_FILE = 'settings.json';
const CHANNELS_FILE = 'channels.json';

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

export function resolveConfigPath(): string {
  return path.resolve(env('CONFIG_PATH') ?? DEFAULT_SETTINGS.configPath);
}

export function loadSettings(): AppSettings {
  const configPath = resolveConfigPath();
  ensureDir(configPath);
  const filePath = path.join(configPath, SETTINGS_FILE);
  let fromFile: Partial<AppSettings> = {};
  if (fs.existsSync(filePath)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<AppSettings>;
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
  };

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
  const toStore: AppSettings = {
    ...settings,
    configPath,
    outputPath: path.resolve(settings.outputPath),
    cachePath: path.resolve(settings.cachePath),
  };
  fs.writeFileSync(path.join(configPath, SETTINGS_FILE), JSON.stringify(toStore, null, 2), 'utf8');
  ensureDir(toStore.outputPath);
  ensureDir(toStore.cachePath);
  return loadSettings();
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
