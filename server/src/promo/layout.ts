/** Seconds per featured item / focus phase. */
export const PHASE_SECONDS = 10;
export const TRANSITION_SECONDS = 1.5;

export type LayoutItemCount = 1 | 2 | 3;

export interface PromoTiming {
  itemCount: LayoutItemCount;
  totalSeconds: number;
  playSeconds: number[];
  preFreezeSeconds: number[];
}

export function clampPromoItemCount(value: unknown): LayoutItemCount {
  const n = typeof value === 'number' ? value : Number(value);
  if (n === 1 || n === 2 || n === 3) return n;
  return 3;
}

/** Timing for N next-items (1→10s, 2→20s, 3→30s). */
export function getPromoTiming(itemCount: unknown): PromoTiming {
  const count = clampPromoItemCount(itemCount);
  const totalSeconds = count * PHASE_SECONDS;
  const preFreezeSeconds: number[] = [];
  for (let i = 0; i < count; i++) {
    preFreezeSeconds.push(i === 0 ? 0 : i * PHASE_SECONDS - TRANSITION_SECONDS);
  }

  const playSeconds: number[] = [];
  for (let i = 0; i < count; i++) {
    const pre = preFreezeSeconds[i]!;
    const nextPre = i + 1 < count ? preFreezeSeconds[i + 1]! : totalSeconds;
    playSeconds.push(nextPre - pre);
  }

  return { itemCount: count, totalSeconds, playSeconds, preFreezeSeconds };
}

/** @deprecated Prefer getPromoTiming(3) — kept for existing tests. */
export const TOTAL_SECONDS = 30;
/** @deprecated Prefer getPromoTiming(3). */
export const T1_START = PHASE_SECONDS - TRANSITION_SECONDS;
/** @deprecated Prefer getPromoTiming(3). */
export const T1_END = PHASE_SECONDS;
/** @deprecated Prefer getPromoTiming(3). */
export const T2_START = PHASE_SECONDS * 2 - TRANSITION_SECONDS;
/** @deprecated Prefer getPromoTiming(3). */
export const T2_END = PHASE_SECONDS * 2;
/** @deprecated Prefer getPromoTiming(3).playSeconds */
export const PLAY_SECONDS = getPromoTiming(3).playSeconds;
/** @deprecated Prefer getPromoTiming(3).preFreezeSeconds */
export const PRE_FREEZE_SECONDS = getPromoTiming(3).preFreezeSeconds;

export interface PanelGeom {
  /** Content strip width prepared before per-frame scale. */
  stripW: number;
  height: number;
  width75: number;
  width50: number;
  width25: number;
  frameW: number;
}

export function panelGeom(frameW: number, frameH: number, itemCount: LayoutItemCount = 3): PanelGeom {
  const width75 = Math.floor((frameW * 3) / 4);
  const width50 = Math.floor(frameW / 2);
  // Exact complement so 75+25 fills the frame for 2-item layouts.
  const width25 = itemCount === 2 ? frameW - width75 : Math.floor(frameW / 4);
  const stripW = itemCount === 1 ? frameW : itemCount === 2 ? width75 : width50;
  return { stripW, height: frameH, width75, width50, width25, frameW };
}

/** Escape commas for ffmpeg filter expressions inside a filtergraph. */
export function escapeExpr(expr: string): string {
  return expr.replace(/,/g, '\\,');
}

/**
 * Smoothstep progress 0..1 between t0 and t1 (raw commas — escape later).
 * p = clip((t-t0)/(t1-t0)); return p*p*(3-2*p)
 */
function smoothProgress(t0: number, t1: number): string {
  const dur = t1 - t0;
  const p = `min(max((t-${t0})/${dur},0),1)`;
  return `(${p})*(${p})*(3-2*(${p}))`;
}

function transitionWindow(afterPhaseIndex: number): { start: number; end: number } {
  const end = (afterPhaseIndex + 1) * PHASE_SECONDS;
  return { start: end - TRANSITION_SECONDS, end };
}

/** Piecewise width for panel A (3-item): 50% → 25% during first transition. */
export function widthExprA(g: PanelGeom): string {
  const { width50: a, width25: b } = g;
  const { start, end } = transitionWindow(0);
  const p = smoothProgress(start, end);
  return escapeExpr(
    `floor(if(lt(t,${start}),${a},if(lt(t,${end}),${a}+(${b}-${a})*${p},${b})))`,
  );
}

/** Panel B (3-item): 25% → 50% → 25%. */
export function widthExprB(g: PanelGeom): string {
  const { width50: mid, width25: side } = g;
  const t1 = transitionWindow(0);
  const t2 = transitionWindow(1);
  const p1 = smoothProgress(t1.start, t1.end);
  const p2 = smoothProgress(t2.start, t2.end);
  return escapeExpr(
    `floor(if(lt(t,${t1.start}),${side},` +
      `if(lt(t,${t1.end}),${side}+(${mid}-${side})*${p1},` +
      `if(lt(t,${t2.start}),${mid},` +
      `if(lt(t,${t2.end}),${mid}+(${side}-${mid})*${p2},${side})))))`,
  );
}

/** Panel C (3-item): 25% → 50% during second transition. */
export function widthExprC(g: PanelGeom): string {
  const { width50: a, width25: b } = g;
  const { start, end } = transitionWindow(1);
  const p = smoothProgress(start, end);
  return escapeExpr(
    `floor(if(lt(t,${start}),${b},if(lt(t,${end}),${b}+(${a}-${b})*${p},${a})))`,
  );
}

/** Overlay X for panel B (= width of A). */
export function xExprB(g: PanelGeom): string {
  return widthExprA(g);
}

/** Overlay X for panel C (= A + B widths). */
export function xExprC(g: PanelGeom): string {
  return `(${widthExprA(g)})+(${widthExprB(g)})`;
}

/** 2-item panel A: 75% → 25% during the focus transition. */
export function widthExprTwoA(g: PanelGeom): string {
  const wide = g.width75;
  const narrow = g.width25;
  const { start, end } = transitionWindow(0);
  const p = smoothProgress(start, end);
  return escapeExpr(
    `floor(if(lt(t,${start}),${wide},if(lt(t,${end}),${wide}+(${narrow}-${wide})*${p},${narrow})))`,
  );
}

/** 2-item panel B: 25% → 75% during the focus transition. */
export function widthExprTwoB(g: PanelGeom): string {
  const wide = g.width75;
  const narrow = g.width25;
  const { start, end } = transitionWindow(0);
  const p = smoothProgress(start, end);
  return escapeExpr(
    `floor(if(lt(t,${start}),${narrow},if(lt(t,${end}),${narrow}+(${wide}-${narrow})*${p},${wide})))`,
  );
}

/** Per-panel width expression for the active item count. */
export function panelWidthExpr(g: PanelGeom, itemCount: LayoutItemCount, panelIndex: number): string {
  if (itemCount === 1) return String(g.frameW);
  if (itemCount === 2) return panelIndex === 0 ? widthExprTwoA(g) : widthExprTwoB(g);
  if (panelIndex === 0) return widthExprA(g);
  if (panelIndex === 1) return widthExprB(g);
  return widthExprC(g);
}

/** Per-panel overlay X for the active item count. */
export function panelXExpr(g: PanelGeom, itemCount: LayoutItemCount, panelIndex: number): string {
  if (panelIndex === 0) return '0';
  if (itemCount === 2) return widthExprTwoA(g);
  if (panelIndex === 1) return xExprB(g);
  return xExprC(g);
}

/** Lower-third bar X: tracks the focused panel (3-item). */
export function barXExpr(g: PanelGeom, margin: number): string {
  const left = margin;
  const center = Math.floor(g.width25) + margin;
  const right = Math.floor(g.width50) + margin;
  const t1 = transitionWindow(0);
  const t2 = transitionWindow(1);
  const p1 = smoothProgress(t1.start, t1.end);
  const p2 = smoothProgress(t2.start, t2.end);
  return escapeExpr(
    `if(lt(t,${t1.start}),${left},` +
      `if(lt(t,${t1.end}),${left}+(${center}-${left})*${p1},` +
      `if(lt(t,${t2.start}),${center},` +
      `if(lt(t,${t2.end}),${center}+(${right}-${center})*${p2},${right}))))`,
  );
}

/** Lower-third bar X for 2-item (tracks 75% focus: left → right). */
export function barXExprTwo(g: PanelGeom, margin: number): string {
  const left = margin;
  const right = g.width25 + margin;
  const { start, end } = transitionWindow(0);
  const p = smoothProgress(start, end);
  return escapeExpr(
    `if(lt(t,${start}),${left},if(lt(t,${end}),${left}+(${right}-${left})*${p},${right}))`,
  );
}

export function barXExprForCount(g: PanelGeom, itemCount: LayoutItemCount, margin: number): string {
  if (itemCount === 1) return barXFixed(margin);
  if (itemCount === 2) return barXExprTwo(g, margin);
  return barXExpr(g, margin);
}

/** Fixed left X when the lower-third spans the full frame. */
export function barXFixed(margin: number): string {
  return String(margin);
}

/** Pixel width of the lower-third graphic. */
export function barPixelWidth(
  frameW: number,
  g: PanelGeom,
  fullWidth: boolean,
  margin: number,
  itemCount: LayoutItemCount = 3,
): number {
  if (fullWidth || itemCount === 1) {
    return Math.max(1, frameW - margin * 2);
  }
  if (itemCount === 2) {
    return Math.max(1, g.width75 - margin - 8);
  }
  return Math.max(1, g.width50 - margin - 8);
}
