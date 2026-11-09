import {
  AppSettings,
  GraphicsPhase,
  GraphicsTemplateSlot,
  sanitizeChannelFolderName,
} from "@promo/shared";
import fs from "node:fs";
import path from "node:path";
import { LEGACY_PROMO_GRAPHICS_TEMPLATE_PATHS } from "../ersatztv/db.js";

export function graphicsElementsRoot(etvConfigPath: string): string {
  return path.join(etvConfigPath, "templates", "graphics-elements");
}

const SLOT_SUFFIX: Record<GraphicsTemplateSlot, string> = {
  now: "now",
  midNow: "mid-now",
  midNext: "mid-next",
  next: "next",
};

/**
 * Flat per-channel path under graphics-elements/image.
 * ETV ListFiles is non-recursive — nested folders are not scanned.
 */
export function channelGraphicsTemplatePath(
  channelNumber: string,
  slot: GraphicsTemplateSlot,
): string {
  const ch = sanitizeChannelFolderName(channelNumber);
  return `image/promo-gen-${ch}-${SLOT_SUFFIX[slot]}.yml`;
}

export function channelGraphicsTemplatePaths(channelNumber: string): string[] {
  return (Object.keys(SLOT_SUFFIX) as GraphicsTemplateSlot[]).map((slot) =>
    channelGraphicsTemplatePath(channelNumber, slot),
  );
}

export function isPromoGenTemplatePath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return (
    normalized.startsWith("image/promo-gen-") ||
    normalized.startsWith("image/promo-gen/")
  );
}

/** LinearFadePoints with fade-in at start and fade-out at end. */
function fadeWindow(start: number, end: number, fade: number): string {
  const peakStart = start + fade;
  const peakEnd = Math.max(peakStart, end - fade);
  return `LinearFadePoints(content_seconds, ${start}, ${peakStart}, ${peakEnd}, ${end})`;
}

/** Same fade shape, timed from content end (before-end bumpers). */
function fadeWindowBeforeEnd(
  beforeEndStart: number,
  beforeEndFinish: number,
  fade: number,
): string {
  const start = `content_total_seconds - ${beforeEndStart}`;
  const peakStart = `content_total_seconds - ${Math.max(0, beforeEndStart - fade)}`;
  const peakEnd = `content_total_seconds - ${beforeEndFinish + fade}`;
  const end = `content_total_seconds - ${beforeEndFinish}`;
  return `LinearFadePoints(content_seconds, ${start}, ${peakStart}, ${peakEnd}, ${end})`;
}

/**
 * Mid bumpers: start at a fraction of content length, then hold for
 * `duration` seconds (with fade in/out). `offsetSeconds` shifts the window
 * (used for midNext after midNow).
 */
function fadeWindowFromContentPercent(
  startPercent: number,
  duration: number,
  fade: number,
  offsetSeconds = 0,
): string {
  const fraction = Number(
    (Math.max(0, Math.min(100, startPercent)) / 100).toFixed(2),
  );

  const start = `content_total_seconds * ${fraction} + ${offsetSeconds}`;
  const peakStart = `content_total_seconds * ${fraction} + ${offsetSeconds + fade}`;
  const peakEnd = `content_total_seconds * ${fraction} + ${offsetSeconds + Math.max(fade, duration - fade)}`;
  const end = `content_total_seconds * ${fraction} + ${offsetSeconds + duration}`;
  return `LinearFadePoints(content_seconds, ${start}, ${peakStart}, ${peakEnd}, ${end})`;
}

function opacityExpression(
  slot: GraphicsTemplateSlot,
  settings: AppSettings,
): string {
  const fade = Math.max(0, settings.graphicsFadeSeconds);

  if (slot === "now") {
    const delay = settings.graphicsNowDelaySeconds;
    const dur = settings.graphicsNowDurationSeconds;
    return fadeWindow(delay, delay + dur, fade);
  }

  if (slot === "next") {
    const before = settings.graphicsNextBeforeEndSeconds;
    const dur = settings.graphicsNextDurationSeconds;
    return fadeWindowBeforeEnd(before + dur, before, fade);
  }

  const midPct = settings.graphicsMidStartPercent;
  const dur = settings.graphicsMidDurationSeconds;

  if (slot === "midNow") {
    return fadeWindowFromContentPercent(midPct, dur, fade);
  }

  return fadeWindowFromContentPercent(midPct, dur, fade, dur);
}

function overlayImageUrl(
  baseUrl: string,
  phase: GraphicsPhase,
  channelNumber: string,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  // Channel baked into per-channel template (ETV has no Channel_Number).
  // Language resolved at request time from channel via ETV.
  // MediaItem_Start = content start for schedule lookup. No string.url_encode
  // (missing in ETV Scriban); UTC Z form stays URL-safe without '+'.
  return (
    `${base}/graphics/overlay.png?phase=${phase}` +
    `&channelNumber=${encodeURIComponent(channelNumber)}` +
    `&at={{ format_datetime MediaItem_Start "UTC" "yyyy-MM-ddTHH:mm:ss.fffZ" }}`
  );
}

function imagePhaseForSlot(slot: GraphicsTemplateSlot): GraphicsPhase {
  return slot === "next" || slot === "midNext" ? "next" : "now";
}

const SLOT_LABELS: Record<GraphicsTemplateSlot, string> = {
  now: "Now",
  midNow: "Mid Now",
  midNext: "Mid Next",
  next: "Next",
};

export function buildGraphicsElementYaml(
  settings: AppSettings,
  slot: GraphicsTemplateSlot,
  channelNumber: string,
): string {
  if (!settings.etvOnDemandBaseUrl?.trim()) {
    throw new Error("etvOnDemandBaseUrl is required for graphics overlays");
  }

  const phase = imagePhaseForSlot(slot);
  const lines = [
    `name: "Promo Generator — ${SLOT_LABELS[slot]} (#${channelNumber})"`,
    `opacity_expression: "${opacityExpression(slot, settings)}"`,
    `location: BottomLeft`,
    `horizontal_margin_percent: 0`,
    `vertical_margin_percent: 0`,
    `z_index: ${slot === "midNext" || slot === "next" ? 21 : 20}`,
    `scale: true`,
    `scale_width_percent: 100`,
    `epg_entries: 1`,
    `image: "${overlayImageUrl(settings.etvOnDemandBaseUrl, phase, channelNumber)}"`,
    "",
  ];

  return lines.join("\n");
}

function cleanupLegacyStillCache(cachePath: string): void {
  if (!cachePath) return;

  const dir = path.join(cachePath, "graphics-stills");
  if (!fs.existsSync(dir)) return;

  fs.rmSync(dir, { recursive: true, force: true });
}

export function slotEnabled(
  slot: GraphicsTemplateSlot,
  settings: AppSettings,
): boolean {
  if (slot === "now") return settings.graphicsNowEnabled;
  if (slot === "next") return settings.graphicsNextEnabled;

  return settings.graphicsMidEnabled;
}

export function enabledGraphicsSlots(
  settings: AppSettings,
): GraphicsTemplateSlot[] {
  return (Object.keys(SLOT_SUFFIX) as GraphicsTemplateSlot[]).filter((slot) =>
    slotEnabled(slot, settings),
  );
}

/** Remove nested/shared templates from earlier iterations. */
function cleanupLegacyTemplates(
  root: string,
  keepRelPaths: Set<string>,
): string[] {
  const removed: string[] = [];
  const imageDir = path.join(root, "image");

  // Old nested layout: image/promo-gen/{channel}/...
  const nestedRoot = path.join(imageDir, "promo-gen");
  if (fs.existsSync(nestedRoot)) {
    fs.rmSync(nestedRoot, { recursive: true, force: true });
    removed.push("image/promo-gen/");
  }

  const shared = [
    ...LEGACY_PROMO_GRAPHICS_TEMPLATE_PATHS,
    "image/promo-gen-now.yml",
    "image/promo-gen-mid-now.yml",
    "image/promo-gen-mid-next.yml",
    "image/promo-gen-next.yml",
  ];

  for (const rel of shared) {
    if (keepRelPaths.has(rel)) continue;

    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      removed.push(rel);
    }
  }

  if (fs.existsSync(imageDir)) {
    for (const name of fs.readdirSync(imageDir)) {
      if (!name.startsWith("promo-gen-") || !name.endsWith(".yml")) continue;

      const rel = `image/${name}`;
      if (keepRelPaths.has(rel)) continue;

      const abs = path.join(imageDir, name);
      fs.unlinkSync(abs);
      removed.push(rel);
    }
  }

  return removed;
}

export function writeGraphicsTemplates(
  settings: AppSettings,
  channelNumbers: string[],
): { written: string[]; removed: string[] } {
  cleanupLegacyStillCache(settings.cachePath);

  const root = graphicsElementsRoot(settings.etvConfigPath);
  fs.mkdirSync(path.join(root, "image"), { recursive: true });

  const slots = enabledGraphicsSlots(settings);
  const allSlots = Object.keys(SLOT_SUFFIX) as GraphicsTemplateSlot[];
  const keepRelPaths = new Set<string>();
  const written: string[] = [];

  for (const channelNumber of channelNumbers) {
    for (const slot of allSlots) {
      const rel = channelGraphicsTemplatePath(channelNumber, slot);
      const abs = path.join(root, rel);
      if (!slots.includes(slot)) {
        if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
        }

        continue;
      }

      keepRelPaths.add(rel);
      fs.writeFileSync(
        abs,
        buildGraphicsElementYaml(settings, slot, channelNumber),
        "utf8",
      );

      written.push(rel);
    }
  }

  const removed = cleanupLegacyTemplates(root, keepRelPaths);

  return { written, removed };
}
