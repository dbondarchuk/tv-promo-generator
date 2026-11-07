import { AppSettings, sanitizeChannelFolderName } from "@promo/shared";
import fs from "node:fs";
import path from "node:path";
import { getPromoTiming } from "../promo/layout.js";
import { formatPromoDuration, livePromoUrl } from "./livePromo.js";

/** Where this app writes `{channel}/next-items.yml` (container-local path). */
export function resolveRemoteStreamsWritePath(settings: AppSettings): string {
  return settings.outputPath;
}

/**
 * Same folder as ErsatzTV sees it (LibraryPath / scan) — uses ETV library path.
 */
export function resolveRemoteStreamsEtvPath(settings: AppSettings): string {
  return settings.etvLibraryPath?.trim() || settings.outputPath;
}

export function remoteStreamYamlPath(
  root: string,
  channelName: string,
): string {
  return path.join(
    root,
    sanitizeChannelFolderName(channelName),
    "next-items.yml",
  );
}

function posixJoinRoot(root: string, channelName: string): string {
  return path.posix.join(
    root.replace(/\\/g, "/").replace(/\/+$/, ""),
    sanitizeChannelFolderName(channelName),
    "next-items.yml",
  );
}

/** Double-quoted YAML scalar safe for channel names that contain `: `. */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Write / update the Remote Stream definition under outputPath. */
export function writeChannelRemoteStreamYaml(
  settings: AppSettings,
  channelNumber: string,
  channelName: string,
): {
  yamlPath: string;
  etvFilePath: string;
  etvRelative: string;
  url: string;
} {
  const base = settings.etvOnDemandBaseUrl?.trim();
  if (!base) {
    throw new Error("etvOnDemandBaseUrl is required for Remote Stream push");
  }

  const writeRoot = resolveRemoteStreamsWritePath(settings);
  const etvRoot = resolveRemoteStreamsEtvPath(settings);
  const yamlPath = remoteStreamYamlPath(writeRoot, channelName);
  fs.mkdirSync(path.dirname(yamlPath), { recursive: true });

  const timing = getPromoTiming(settings.promoItemCount);
  const url = livePromoUrl(base, channelNumber);
  const duration = formatPromoDuration(timing.totalSeconds);
  // Quote strings — unquoted titles with ": " (e.g. "Movies: Comedy") are invalid YAML
  // and ErsatzTV's scanner drops the file. Duration must stay a string for TimeSpan.TryParse.
  const body = [
    `url: ${yamlString(url)}`,
    // Generated on request — ETV must NOT work ahead (SeekAndWorkAhead + our
    // progressive MPEG-TS stalls at ~0.4x). duration still schedules the slot.
    `is_live: true`,
    `duration: ${yamlString(duration)}`,
    `title: ${yamlString(`Promo Generator - Next - ${channelName}`)}`,
    "",
  ].join("\n");

  fs.writeFileSync(yamlPath, body, "utf8");

  const etvRelative = path.posix.join(
    sanitizeChannelFolderName(channelName),
    "next-items.yml",
  );

  return {
    yamlPath,
    etvFilePath: posixJoinRoot(etvRoot, channelName),
    etvRelative,
    url,
  };
}
