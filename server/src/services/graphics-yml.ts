import {
  AppSettings,
  GraphicsPhase,
  GraphicsTemplateSlot,
} from "@promo/shared";
import fs from "node:fs";
import path from "node:path";
import {
  LEGACY_PROMO_GRAPHICS_TEMPLATE_PATHS,
  PROMO_GRAPHICS_TEMPLATE_PATHS,
} from "../ersatztv/db.js";

export function graphicsElementsRoot(etvConfigPath: string): string {
  return path.join(etvConfigPath, "templates", "graphics-elements");
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
  // Visible from (total - beforeEndStart) … (total - beforeEndFinish).
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

  // Mid sequence: Now bumper, full fade-out, then Next bumper fade-in.
  const delay = settings.graphicsMidDelaySeconds;
  const dur = settings.graphicsMidDurationSeconds;

  if (slot === "midNow") {
    return fadeWindow(delay, delay + dur, fade);
  }

  // midNext starts after midNow ends (sequential fade-out then fade-in).
  return fadeWindow(delay + dur, delay + 2 * dur, fade);
}

function overlayImageUrl(baseUrl: string, phase: GraphicsPhase): string {
  const base = baseUrl.replace(/\/+$/, "");
  // MediaItem_Id from ETV playout context (accurate even if our DB lags).
  // channelNumber remains for name/language/color; schedule fallback if id omitted.
  return (
    `${base}/graphics/overlay.png?phase=${phase}` +
    `&mediaItemId={{ MediaItem_Id }}` +
    `&channelNumber={{ Channel_Number }}`
  );
}

function imagePhaseForSlot(slot: GraphicsTemplateSlot): GraphicsPhase {
  return slot === "next" || slot === "midNext" ? "next" : "now";
}

export function buildGraphicsElementYaml(
  settings: AppSettings,
  slot: GraphicsTemplateSlot,
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
    `image: "${overlayImageUrl(settings.etvOnDemandBaseUrl, phase)}"`,
    "",
  ];

  return lines.join("\n");
}

/** Remove disk still cache from the first overlay implementation (now piped). */
function cleanupLegacyStillCache(cachePath: string): void {
  if (!cachePath) return;

  const dir = path.join(cachePath, "graphics-stills");
  if (!fs.existsSync(dir)) return;

  fs.rmSync(dir, { recursive: true, force: true });
}

function slotEnabled(
  slot: GraphicsTemplateSlot,
  settings: AppSettings,
): boolean {
  if (slot === "now") return settings.graphicsNowEnabled;
  if (slot === "next") return settings.graphicsNextEnabled;

  return settings.graphicsMidEnabled;
}

export function writeGraphicsTemplates(settings: AppSettings): {
  written: string[];
  removed: string[];
} {
  cleanupLegacyStillCache(settings.cachePath);

  const root = graphicsElementsRoot(settings.etvConfigPath);
  fs.mkdirSync(path.join(root, "image"), { recursive: true });

  const written: string[] = [];
  const removed: string[] = [];

  for (const slot of Object.keys(
    PROMO_GRAPHICS_TEMPLATE_PATHS,
  ) as GraphicsTemplateSlot[]) {
    const rel = PROMO_GRAPHICS_TEMPLATE_PATHS[slot];
    const abs = path.join(root, rel);
    if (!slotEnabled(slot, settings)) {
      if (fs.existsSync(abs)) {
        fs.unlinkSync(abs);
        removed.push(rel);
      }

      continue;
    }

    fs.writeFileSync(abs, buildGraphicsElementYaml(settings, slot), "utf8");
    written.push(rel);
  }

  for (const rel of LEGACY_PROMO_GRAPHICS_TEMPLATE_PATHS) {
    const abs = path.join(root, rel);
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      removed.push(rel);
    }
  }

  return { written, removed };
}
