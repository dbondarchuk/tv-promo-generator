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

const SLOT_FILES: Record<GraphicsTemplateSlot, string> = {
  now: "now.yml",
  midNow: "mid-now.yml",
  midNext: "mid-next.yml",
  next: "next.yml",
};

/** Per-channel relative template path under graphics-elements. */
export function channelGraphicsTemplatePath(
  channelNumber: string,
  slot: GraphicsTemplateSlot,
): string {
  const folder = sanitizeChannelFolderName(channelNumber);
  return `image/promo-gen/${folder}/${SLOT_FILES[slot]}`;
}

export function channelGraphicsTemplatePaths(channelNumber: string): string[] {
  return (Object.keys(SLOT_FILES) as GraphicsTemplateSlot[]).map((slot) =>
    channelGraphicsTemplatePath(channelNumber, slot),
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

  const delay = settings.graphicsMidDelaySeconds;
  const dur = settings.graphicsMidDurationSeconds;

  if (slot === "midNow") {
    return fadeWindow(delay, delay + dur, fade);
  }

  return fadeWindow(delay + dur, delay + 2 * dur, fade);
}

function overlayImageUrl(
  baseUrl: string,
  phase: GraphicsPhase,
  channelNumber: string,
): string {
  const base = baseUrl.replace(/\/+$/, "");
  // Channel baked into per-channel template (ETV has no Channel_Number).
  // MediaItem_Start = content start — schedule lookup for now/next (troubleshoot-safe).
  return (
    `${base}/graphics/overlay.png?phase=${phase}` +
    `&channelNumber=${encodeURIComponent(channelNumber)}` +
    `&at={{ format_datetime MediaItem_Start "UTC" "o" | string.url_encode }}`
  );
}

function imagePhaseForSlot(slot: GraphicsTemplateSlot): GraphicsPhase {
  return slot === "next" || slot === "midNext" ? "next" : "now";
}

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
  return (Object.keys(SLOT_FILES) as GraphicsTemplateSlot[]).filter((slot) =>
    slotEnabled(slot, settings),
  );
}

/** Remove shared (non-per-channel) templates from earlier iterations. */
function cleanupSharedLegacyTemplates(root: string): string[] {
  const removed: string[] = [];
  const shared = [
    ...LEGACY_PROMO_GRAPHICS_TEMPLATE_PATHS,
    "image/promo-gen-now.yml",
    "image/promo-gen-mid-now.yml",
    "image/promo-gen-mid-next.yml",
    "image/promo-gen-next.yml",
  ];

  for (const rel of shared) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      removed.push(rel);
    }
  }

  return removed;
}

/** Remove per-channel template folders that are no longer targeted. */
function cleanupStaleChannelFolders(
  root: string,
  keepChannelFolders: Set<string>,
): string[] {
  const removed: string[] = [];
  const promoRoot = path.join(root, "image", "promo-gen");
  if (!fs.existsSync(promoRoot)) return removed;

  for (const entry of fs.readdirSync(promoRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (keepChannelFolders.has(entry.name)) continue;

    const abs = path.join(promoRoot, entry.name);
    fs.rmSync(abs, { recursive: true, force: true });
    removed.push(`image/promo-gen/${entry.name}/`);
  }

  return removed;
}

export function writeGraphicsTemplates(
  settings: AppSettings,
  channelNumbers: string[],
): { written: string[]; removed: string[] } {
  cleanupLegacyStillCache(settings.cachePath);

  const root = graphicsElementsRoot(settings.etvConfigPath);
  fs.mkdirSync(path.join(root, "image", "promo-gen"), { recursive: true });

  const written: string[] = [];
  const removed: string[] = [...cleanupSharedLegacyTemplates(root)];

  const keepFolders = new Set(
    channelNumbers.map((n) => sanitizeChannelFolderName(n)),
  );

  const slots = enabledGraphicsSlots(settings);
  const allSlots = Object.keys(SLOT_FILES) as GraphicsTemplateSlot[];

  for (const channelNumber of channelNumbers) {
    const folder = sanitizeChannelFolderName(channelNumber);
    const dir = path.join(root, "image", "promo-gen", folder);
    fs.mkdirSync(dir, { recursive: true });

    for (const slot of allSlots) {
      const rel = channelGraphicsTemplatePath(channelNumber, slot);
      const abs = path.join(root, rel);
      if (!slots.includes(slot)) {
        if (fs.existsSync(abs)) {
          fs.unlinkSync(abs);
          removed.push(rel);
        }

        continue;
      }

      fs.writeFileSync(
        abs,
        buildGraphicsElementYaml(settings, slot, channelNumber),
        "utf8",
      );

      written.push(rel);
    }
  }

  removed.push(...cleanupStaleChannelFolders(root, keepFolders));

  return { written, removed };
}
