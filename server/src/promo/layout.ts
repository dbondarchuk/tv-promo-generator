/** Timing for the 3-panel next-items promo layout. */
export const TOTAL_SECONDS = 30;
export const PHASE_SECONDS = 10;
export const TRANSITION_SECONDS = 1.5;

/** When each focus transition begins / ends. */
export const T1_START = PHASE_SECONDS - TRANSITION_SECONDS; // 8.5
export const T1_END = PHASE_SECONDS; // 10
export const T2_START = PHASE_SECONDS * 2 - TRANSITION_SECONDS; // 18.5
export const T2_END = PHASE_SECONDS * 2; // 20

/** How long each item's clip plays (before freeze). */
export const PLAY_SECONDS = [T1_START, T2_START - T1_START, TOTAL_SECONDS - T2_START] as const;
/** Hold first frame this long before play begins. */
export const PRE_FREEZE_SECONDS = [0, T1_START, T2_START] as const;

export interface PanelGeom {
  /** Max strip width (50% of frame) — content is prepared at this size. */
  stripW: number;
  height: number;
  width50: number;
  width25: number;
}

export function panelGeom(frameW: number, frameH: number): PanelGeom {
  const width50 = Math.floor(frameW / 2);
  const width25 = Math.floor(frameW / 4);
  return { stripW: width50, height: frameH, width50, width25 };
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

/** Piecewise width for panel A: 50% → 25% during first transition. */
export function widthExprA(g: PanelGeom): string {
  const { width50: a, width25: b } = g;
  const p = smoothProgress(T1_START, T1_END);
  return escapeExpr(
    `floor(if(lt(t,${T1_START}),${a},if(lt(t,${T1_END}),${a}+(${b}-${a})*${p},${b})))`,
  );
}

/** Panel B: 25% → 50% → 25%. */
export function widthExprB(g: PanelGeom): string {
  const { width50: mid, width25: side } = g;
  const p1 = smoothProgress(T1_START, T1_END);
  const p2 = smoothProgress(T2_START, T2_END);
  return escapeExpr(
    `floor(if(lt(t,${T1_START}),${side},` +
      `if(lt(t,${T1_END}),${side}+(${mid}-${side})*${p1},` +
      `if(lt(t,${T2_START}),${mid},` +
      `if(lt(t,${T2_END}),${mid}+(${side}-${mid})*${p2},${side})))))`,
  );
}

/** Panel C: 25% → 50% during second transition. */
export function widthExprC(g: PanelGeom): string {
  const { width50: a, width25: b } = g;
  const p = smoothProgress(T2_START, T2_END);
  return escapeExpr(
    `floor(if(lt(t,${T2_START}),${b},if(lt(t,${T2_END}),${b}+(${a}-${b})*${p},${a})))`,
  );
}

/** Overlay X for panel B (= width of A). */
export function xExprB(g: PanelGeom): string {
  return widthExprA(g);
}

/** Overlay X for panel C (= A + B widths). */
export function xExprC(g: PanelGeom): string {
  // Both parts already comma-escaped; join with escaped + is fine.
  return `(${widthExprA(g)})+(${widthExprB(g)})`;
}

/** Crop X within the 50% strip — left / center / right anchored. */
export function cropXExpr(anchor: 'left' | 'center' | 'right', g: PanelGeom, widthExpr: string): string {
  if (anchor === 'left') return '0';
  // widthExpr is already comma-escaped; these forms introduce no new commas.
  if (anchor === 'center') return `(${g.stripW}-(${widthExpr}))/2`;
  return `${g.stripW}-(${widthExpr})`;
}

/** Lower-third bar X: tracks the focused (50%) panel. */
export function barXExpr(g: PanelGeom, margin: number): string {
  const left = margin;
  const center = Math.floor(g.width25) + margin;
  const right = Math.floor(g.width50) + margin;
  const p1 = smoothProgress(T1_START, T1_END);
  const p2 = smoothProgress(T2_START, T2_END);
  return escapeExpr(
    `if(lt(t,${T1_START}),${left},` +
      `if(lt(t,${T1_END}),${left}+(${center}-${left})*${p1},` +
      `if(lt(t,${T2_START}),${center},` +
      `if(lt(t,${T2_END}),${center}+(${right}-${center})*${p2},${right}))))`,
  );
}
