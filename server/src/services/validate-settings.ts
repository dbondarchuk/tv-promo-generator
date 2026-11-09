import {
  AppSettings,
  SettingsCheck,
  ValidateSettingsResult,
  isPromoItemCount,
  parseResolution,
} from "@promo/shared";
import fs from "node:fs";
import path from "node:path";
import { EtvApiClient } from "../ersatztv/api.js";
import { loadSchema, openDb, resetSchemaCache } from "../ersatztv/db.js";
import { resolveFfmpegBinaries } from "../ffmpeg/binaries.js";
import { createLogger } from "../util/log.js";

const log = createLogger("validate");

function check(
  id: string,
  label: string,
  ok: boolean,
  message: string,
): SettingsCheck {
  return { id, label, ok, message };
}

function dirStatus(
  dir: string,
  label: string,
  createHint: boolean,
): SettingsCheck {
  const id = label;
  const resolved = path.resolve(dir || "");
  if (!dir?.trim()) {
    return check(id, label, false, "Path is empty");
  }

  if (fs.existsSync(resolved)) {
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) {
      return check(id, label, false, `Not a directory: ${resolved}`);
    }

    try {
      fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
      return check(id, label, true, resolved);
    } catch {
      return check(id, label, false, `Not writable: ${resolved}`);
    }
  }

  if (createHint) {
    return check(id, label, true, `Will be created: ${resolved}`);
  }

  return check(id, label, false, `Missing: ${resolved}`);
}

export async function validateSettings(
  settings: AppSettings,
): Promise<ValidateSettingsResult> {
  const checks: SettingsCheck[] = [];

  try {
    const url = new URL(settings.etvUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      checks.push(
        check(
          "etvUrl",
          "ErsatzTV URL",
          false,
          `Unsupported protocol: ${url.protocol}`,
        ),
      );
    } else {
      checks.push(check("etvUrl", "ErsatzTV URL", true, url.toString()));
    }
  } catch {
    checks.push(check("etvUrl", "ErsatzTV URL", false, "Invalid URL"));
  }

  checks.push(
    settings.etvApiKey.trim()
      ? check("etvApiKey", "API key", true, "Set")
      : check(
          "etvApiKey",
          "API key",
          true,
          "Empty — OK if ErsatzTV auth is disabled",
        ),
  );

  const dbPath = settings.etvDatabase?.trim();
  if (!dbPath) {
    checks.push(check("etvDatabase", "Database path", false, "Not configured"));
  } else if (!fs.existsSync(dbPath)) {
    checks.push(
      check("etvDatabase", "Database path", false, `File not found: ${dbPath}`),
    );
  } else {
    try {
      resetSchemaCache();
      const db = openDb(dbPath, true);
      try {
        const schema = loadSchema(db);
        const required = [
          "Channel",
          "Playout",
          "ProgramScheduleItem",
          "FillerPreset",
          "Library",
        ];

        const missing = required.filter((t) => !schema.tables.has(t));
        if (missing.length) {
          checks.push(
            check(
              "etvDatabase",
              "Database path",
              false,
              `Missing tables: ${missing.join(", ")}`,
            ),
          );
        } else {
          checks.push(
            check(
              "etvDatabase",
              "Database path",
              true,
              `Readable SQLite (${dbPath})`,
            ),
          );
        }
      } finally {
        db.close();
      }
    } catch (err) {
      checks.push(
        check(
          "etvDatabase",
          "Database path",
          false,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  const remoteMode = settings.promoDeliveryMode !== "file";

  checks.push(dirStatus(settings.libraryPath, "Library path", false));
  checks.push(
    dirStatus(
      settings.outputPath,
      remoteMode ? "Output path (YAML write)" : "Output path (MP4 write)",
      true,
    ),
  );

  checks.push(dirStatus(settings.cachePath, "Cache path", true));
  checks.push(
    dirStatus(
      settings.etvLibraryPath || settings.outputPath,
      remoteMode
        ? "ETV library path (Remote Streams)"
        : "ETV library path (Other Videos)",
      true,
    ),
  );

  checks.push(
    check(
      "promoDeliveryMode",
      "Promo delivery",
      settings.promoDeliveryMode === "file" ||
        settings.promoDeliveryMode === "remote-stream",
      settings.promoDeliveryMode === "file"
        ? "File (baked MP4)"
        : "Remote Stream (live encode)",
    ),
  );

  const onDemand = settings.etvOnDemandBaseUrl?.trim();
  if (remoteMode) {
    if (!onDemand) {
      checks.push(
        check(
          "etvOnDemandBaseUrl",
          "On-demand base URL",
          false,
          "Required for Remote Stream delivery",
        ),
      );
    } else {
      try {
        const u = new URL(onDemand);
        checks.push(
          check(
            "etvOnDemandBaseUrl",
            "On-demand base URL",
            ["http:", "https:"].includes(u.protocol),
            u.toString(),
          ),
        );
      } catch {
        checks.push(
          check(
            "etvOnDemandBaseUrl",
            "On-demand base URL",
            false,
            "Invalid URL",
          ),
        );
      }
    }
  } else if (onDemand) {
    try {
      const u = new URL(onDemand);
      checks.push(
        check(
          "etvOnDemandBaseUrl",
          "On-demand base URL",
          ["http:", "https:"].includes(u.protocol),
          `${u.toString()} (unused in file mode)`,
        ),
      );
    } catch {
      checks.push(
        check(
          "etvOnDemandBaseUrl",
          "On-demand base URL",
          true,
          "Invalid URL (unused in file mode)",
        ),
      );
    }
  }

  const etvConfig = settings.etvConfigPath?.trim();
  if (etvConfig) {
    const templates = path.join(etvConfig, "templates", "graphics-elements");

    checks.push(
      check(
        "etvConfigPath",
        "ETV config path",
        fs.existsSync(etvConfig),
        fs.existsSync(etvConfig)
          ? `OK · graphics templates → ${templates}`
          : `Not found: ${etvConfig}`,
      ),
    );
  } else {
    checks.push(
      check(
        "etvConfigPath",
        "ETV config path",
        true,
        "Not set (required for Push Graphics)",
      ),
    );
  }

  if (settings.etvPathPrefix && !settings.libraryPath) {
    checks.push(
      check(
        "etvPathPrefix",
        "Path rewrite",
        false,
        "etvPathPrefix is set but libraryPath is empty",
      ),
    );
  } else if (settings.etvPathPrefix) {
    checks.push(
      check(
        "etvPathPrefix",
        "Path rewrite",
        true,
        `${settings.etvPathPrefix} → ${settings.libraryPath}`,
      ),
    );
  } else {
    checks.push(
      check(
        "etvPathPrefix",
        "Path rewrite",
        true,
        "Not set (paths used as-is)",
      ),
    );
  }

  const res = parseResolution(settings.resolution);
  const resOk = /^\d+x\d+$/i.test(settings.resolution.trim());
  checks.push(
    check(
      "resolution",
      "Resolution",
      resOk,
      resOk ? `${res.width}x${res.height}` : `Invalid "${settings.resolution}"`,
    ),
  );

  const bitrateOk =
    Number.isFinite(settings.videoBitrate) &&
    settings.videoBitrate > 0 &&
    Number.isFinite(settings.audioBitrate) &&
    settings.audioBitrate > 0;

  checks.push(
    check(
      "bitrate",
      "Bitrates",
      bitrateOk,
      bitrateOk
        ? `video ${settings.videoBitrate} / audio ${settings.audioBitrate} kbps`
        : "videoBitrate and audioBitrate must be positive",
    ),
  );

  const portOk =
    Number.isInteger(settings.port) &&
    settings.port >= 1 &&
    settings.port <= 65535;

  checks.push(
    check(
      "port",
      "HTTP port",
      portOk,
      portOk ? String(settings.port) : "Must be 1–65535",
    ),
  );

  const leadOk =
    Number.isFinite(settings.regenLeadMinutes) &&
    settings.regenLeadMinutes >= 0;

  checks.push(
    check(
      "regenLeadMinutes",
      "Regen lead",
      leadOk,
      leadOk ? `${settings.regenLeadMinutes} min` : "Must be ≥ 0",
    ),
  );

  checks.push(
    check(
      "voiceProvider",
      "Voice provider",
      true,
      settings.voiceEnabled
        ? `${settings.voiceProvider}${settings.piperUrl.trim() ? ` · Piper ${settings.piperUrl.trim()}` : ""}`
        : "Voice-over disabled",
    ),
  );

  const pauseOk =
    Number.isFinite(settings.voicePauseMs) && settings.voicePauseMs >= 0;

  checks.push(
    check(
      "voicePauseMs",
      "Voice pause",
      pauseOk,
      pauseOk ? `${settings.voicePauseMs} ms` : "Must be ≥ 0",
    ),
  );

  const timeoutOk =
    Number.isFinite(settings.ttsTimeoutMs) && settings.ttsTimeoutMs >= 1000;

  checks.push(
    check(
      "ttsTimeoutMs",
      "TTS timeout",
      timeoutOk,
      timeoutOk ? `${settings.ttsTimeoutMs} ms` : "Must be ≥ 1000",
    ),
  );

  const itemCountOk = isPromoItemCount(settings.promoItemCount);
  checks.push(
    check(
      "promoItemCount",
      "Promo items",
      itemCountOk,
      itemCountOk
        ? `${settings.promoItemCount} → ${settings.promoItemCount * 10}s`
        : "Must be 1, 2, or 3",
    ),
  );

  const sourceVolOk =
    Number.isFinite(settings.sourceAudioVolume) &&
    settings.sourceAudioVolume >= 0 &&
    settings.sourceAudioVolume <= 100;

  checks.push(
    check(
      "sourceAudioVolume",
      "Original item audio",
      sourceVolOk,
      sourceVolOk
        ? settings.sourceAudioVolume <= 0
          ? "Skipped (0)"
          : `${Math.round(settings.sourceAudioVolume)}%` +
            (settings.sourceAudioAfterVoice ? " · after VO" : " · under VO")
        : "Must be 0–100",
    ),
  );

  if (settings.voiceEnabled && settings.voiceProvider === "piper") {
    const piperOk = Boolean(settings.piperUrl.trim());
    checks.push(
      check(
        "piperUrl",
        "Piper URL",
        piperOk,
        piperOk
          ? settings.piperUrl.trim()
          : "Required when voice provider is Piper",
      ),
    );
  } else if (settings.piperUrl.trim()) {
    try {
      const url = new URL(settings.piperUrl.trim());
      checks.push(check("piperUrl", "Piper URL", true, url.toString()));
    } catch {
      checks.push(check("piperUrl", "Piper URL", false, "Invalid URL"));
    }
  }

  if (
    settings.voiceEnabled &&
    settings.voiceProvider === "sapi" &&
    process.platform !== "win32"
  ) {
    checks.push(
      check(
        "voiceProvider",
        "Windows SAPI",
        false,
        "SAPI is only available on Windows",
      ),
    );
  }

  try {
    const bins = resolveFfmpegBinaries();
    const { spawnSync } = await import("node:child_process");
    const ff = spawnSync(bins.ffmpeg, ["-version"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
    });

    const fp = spawnSync(bins.ffprobe, ["-version"], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
    });

    if (ff.status === 0 && fp.status === 0) {
      const ver = (ff.stdout || "").split("\n")[0]?.trim() || bins.ffmpeg;
      checks.push(
        check("ffmpeg", "ffmpeg / ffprobe", true, `${ver} (${bins.source})`),
      );
    } else {
      checks.push(
        check(
          "ffmpeg",
          "ffmpeg / ffprobe",
          false,
          `Not runnable (ffmpeg=${bins.ffmpeg}, ffprobe=${bins.ffprobe})`,
        ),
      );
    }
  } catch (err) {
    checks.push(
      check(
        "ffmpeg",
        "ffmpeg / ffprobe",
        false,
        err instanceof Error ? err.message : String(err),
      ),
    );
  }

  if (checks.find((c) => c.id === "etvUrl")?.ok) {
    try {
      const api = new EtvApiClient(settings.etvUrl, settings.etvApiKey, 8_000);
      const channels = await api.getChannels();
      checks.push(
        check(
          "etvReachable",
          "ErsatzTV API",
          true,
          `Reachable — ${channels.length} channel(s)`,
        ),
      );
    } catch (err) {
      checks.push(
        check(
          "etvReachable",
          "ErsatzTV API",
          false,
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  } else {
    checks.push(
      check("etvReachable", "ErsatzTV API", false, "Skipped — invalid URL"),
    );
  }

  const ok = checks.every((c) => c.ok);
  log.info("settings validated", {
    ok,
    failed: checks.filter((c) => !c.ok).map((c) => c.id),
  });

  return { ok, checks };
}
