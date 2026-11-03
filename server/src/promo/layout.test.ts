import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAY_SECONDS,
  PRE_FREEZE_SECONDS,
  T1_END,
  T1_START,
  T2_END,
  TOTAL_SECONDS,
  barPixelWidth,
  barXExprForCount,
  barXFixed,
  getPromoTiming,
  panelGeom,
  panelWidthExpr,
  widthExprA,
  widthExprB,
  widthExprC,
} from "./layout.js";

test("play windows continue through outgoing transitions (3-item)", () => {
  assert.equal(PRE_FREEZE_SECONDS[0], 0);
  assert.equal(PLAY_SECONDS[0], T1_END);
  assert.equal(PRE_FREEZE_SECONDS[1], T1_START);
  assert.equal(PRE_FREEZE_SECONDS[1]! + PLAY_SECONDS[1]!, T2_END);
  assert.equal(PRE_FREEZE_SECONDS[2]! + PLAY_SECONDS[2]!, TOTAL_SECONDS);
});

test("getPromoTiming scales 1/2/3 items to 10/20/30s", () => {
  assert.equal(getPromoTiming(1).totalSeconds, 10);
  assert.deepEqual(getPromoTiming(1).preFreezeSeconds, [0]);
  assert.deepEqual(getPromoTiming(1).playSeconds, [10]);

  const two = getPromoTiming(2);
  assert.equal(two.totalSeconds, 20);
  assert.equal(two.preFreezeSeconds[0], 0);
  assert.equal(two.preFreezeSeconds[1], 8.5);
  assert.deepEqual(two.playSeconds, [10, 11.5]);

  const three = getPromoTiming(3);
  assert.equal(three.totalSeconds, 30);
  assert.deepEqual(three.playSeconds, [...PLAY_SECONDS]);
  assert.deepEqual(three.playSeconds, [10, 11.5, 11.5]);
});

test("panel geom: full / 75% / 50% strips by item count", () => {
  const one = panelGeom(1920, 1080, 1);
  assert.equal(one.stripW, 1920);

  const two = panelGeom(1920, 1080, 2);
  assert.equal(two.stripW, 1440);
  assert.equal(two.width75, 1440);
  assert.equal(two.width25, 480);
  assert.equal(two.width75 + two.width25, 1920);

  const three = panelGeom(1920, 1080, 3);
  assert.equal(three.stripW, 960);
});

test("width expressions escape commas for filtergraph", () => {
  const g3 = panelGeom(1920, 1080, 3);
  for (const expr of [widthExprA(g3), widthExprB(g3), widthExprC(g3)]) {
    assert.ok(expr.includes("if(lt(t\\,"));
    assert.equal(
      [...expr].filter((ch, i) => ch === "," && expr[i - 1] !== "\\").length,
      0,
    );
  }

  const g2 = panelGeom(1920, 1080, 2);
  for (const expr of [panelWidthExpr(g2, 2, 0), panelWidthExpr(g2, 2, 1)]) {
    assert.ok(expr.includes("if(lt(t\\,"));
    assert.ok(expr.includes("1440"));
    assert.ok(expr.includes("480"));
  }
});

test("1-item panel is full frame; 2-item animates 75/25", () => {
  const g1 = panelGeom(1920, 1080, 1);
  assert.equal(panelWidthExpr(g1, 1, 0), "1920");

  const g2 = panelGeom(1920, 1080, 2);
  assert.ok(panelWidthExpr(g2, 2, 0).includes("1440"));
  assert.ok(panelWidthExpr(g2, 2, 1).includes("480"));
});

test("full-width lower-third stays left and spans frame", () => {
  const g = panelGeom(1920, 1080, 3);
  assert.equal(barXFixed(40), "40");
  assert.equal(barPixelWidth(1920, g, true, 40, 3), 1840);
  assert.equal(barPixelWidth(1920, g, false, 40, 3), g.width50 - 48);
  assert.equal(barPixelWidth(1920, g, false, 40, 1), 1840);
  assert.equal(
    barPixelWidth(1920, panelGeom(1920, 1080, 2), false, 40, 2),
    1440 - 48,
  );

  assert.equal(barXExprForCount(g, 1, 40), "40");
});
