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

function envInt(name: string, fallback: number): number {
  const value = env(name);
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
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

  const merged: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...fromFile,
    configPath,
    etvUrl: env('ETV_URL') ?? fromFile.etvUrl ?? DEFAULT_SETTINGS.etvUrl,
    etvApiKey: env('ETV_API_KEY') ?? fromFile.etvApiKey ?? DEFAULT_SETTINGS.etvApiKey,
    etvDatabase: env('ETV_DATABASE') ?? fromFile.etvDatabase ?? DEFAULT_SETTINGS.etvDatabase,
    libraryPath: env('LIBRARY_PATH') ?? fromFile.libraryPath ?? DEFAULT_SETTINGS.libraryPath,
    etvPathPrefix: env('ETV_PATH_PREFIX') ?? fromFile.etvPathPrefix ?? DEFAULT_SETTINGS.etvPathPrefix,
    outputPath: path.resolve(env('OUTPUT_PATH') ?? fromFile.outputPath ?? DEFAULT_SETTINGS.outputPath),
    etvLibraryPath: env('ETV_LIBRARY_PATH') ?? fromFile.etvLibraryPath ?? DEFAULT_SETTINGS.etvLibraryPath,
    cachePath: path.resolve(env('CACHE_PATH') ?? fromFile.cachePath ?? DEFAULT_SETTINGS.cachePath),
    port: envInt('PORT', fromFile.port ?? DEFAULT_SETTINGS.port),
    hardwareAcceleration: (env('HARDWARE_ACCELERATION') as HardwareAcceleration | undefined)
      ?? fromFile.hardwareAcceleration
      ?? DEFAULT_SETTINGS.hardwareAcceleration,
    vaapiDevice: env('VAAPI_DEVICE') ?? fromFile.vaapiDevice ?? DEFAULT_SETTINGS.vaapiDevice,
    vaapiDriver: (env('VAAPI_DRIVER') as VaapiDriver | undefined)
      ?? fromFile.vaapiDriver
      ?? DEFAULT_SETTINGS.vaapiDriver,
    vaapiDisplay: env('VAAPI_DISPLAY') ?? fromFile.vaapiDisplay ?? DEFAULT_SETTINGS.vaapiDisplay,
    videoCodec: (env('VIDEO_CODEC') as VideoCodec | undefined) ?? fromFile.videoCodec ?? DEFAULT_SETTINGS.videoCodec,
    videoBitrate: envInt('VIDEO_BITRATE', fromFile.videoBitrate ?? DEFAULT_SETTINGS.videoBitrate),
    audioBitrate: envInt('AUDIO_BITRATE', fromFile.audioBitrate ?? DEFAULT_SETTINGS.audioBitrate),
    resolution: env('RESOLUTION') ?? fromFile.resolution ?? DEFAULT_SETTINGS.resolution,
    videoPreset: env('VIDEO_PRESET') ?? fromFile.videoPreset ?? DEFAULT_SETTINGS.videoPreset,
    videoProfile: env('VIDEO_PROFILE') ?? fromFile.videoProfile ?? DEFAULT_SETTINGS.videoProfile,
    voiceEnabled: env('VOICE_ENABLED') !== undefined
      ? envBool('VOICE_ENABLED', true)
      : (fromFile.voiceEnabled ?? DEFAULT_SETTINGS.voiceEnabled),
    regenLeadMinutes: envInt('REGEN_LEAD_MINUTES', fromFile.regenLeadMinutes ?? DEFAULT_SETTINGS.regenLeadMinutes),
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
