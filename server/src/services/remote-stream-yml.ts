import { AppSettings, sanitizeChannelFolderName } from "@promo/shared";
import fs from "node:fs";
import path from "node:path";
import { getPromoTiming } from "../promo/layout.js";
import { formatPromoDuration, livePromoUrl } from "./livePromo.js";

export function resolveRemoteStreamsPath(settings: AppSettings): string {
  return (
    settings.etvRemoteStreamsPath?.trim() ||
    settings.etvLibraryPath?.trim() ||
    settings.outputPath
  );
}

export function remoteStreamYamlPath(
  remoteStreamsRoot: string,
  channelName: string,
): string {
  return path.join(
    remoteStreamsRoot,
    sanitizeChannelFolderName(channelName),
    "next-items.yml",
  );
}

/** Write / update the Remote Stream definition ETV will scan. */
export function writeChannelRemoteStreamYaml(
  settings: AppSettings,
  channelNumber: string,
  channelName: string,
): { yamlPath: string; etvRelative: string; url: string } {
  const base = settings.etvOnDemandBaseUrl?.trim();
  if (!base) {
    throw new Error("etvOnDemandBaseUrl is required for Remote Stream push");
  }

  const root = resolveRemoteStreamsPath(settings);
  const yamlPath = remoteStreamYamlPath(root, channelName);
  fs.mkdirSync(path.dirname(yamlPath), { recursive: true });

  const timing = getPromoTiming(settings.promoItemCount);
  const url = livePromoUrl(base, channelNumber);
  const duration = formatPromoDuration(timing.totalSeconds);
  const body = [
    `url: ${url}`,
    `is_live: true`,
    `duration: ${duration}`,
    `title: Promo Generator - Next - ${channelName}`,
    "",
  ].join("\n");

  fs.writeFileSync(yamlPath, body, "utf8");

  const etvRelative = path.posix.join(
    sanitizeChannelFolderName(channelName),
    "next-items.yml",
  );

  return { yamlPath, etvRelative, url };
}
