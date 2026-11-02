import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLAY_SECONDS,
  PRE_FREEZE_SECONDS,
  T1_START,
  T2_START,
  TOTAL_SECONDS,
  panelGeom,
  widthExprA,
  widthExprB,
  widthExprC,
} from './layout.js';

test('play windows align to transition points', () => {
  assert.equal(PRE_FREEZE_SECONDS[0], 0);
  assert.equal(PLAY_SECONDS[0], T1_START);
  assert.equal(PRE_FREEZE_SECONDS[1], T1_START);
  assert.equal(PRE_FREEZE_SECONDS[1]! + PLAY_SECONDS[1]!, T2_START);
  assert.equal(PRE_FREEZE_SECONDS[2]! + PLAY_SECONDS[2]!, TOTAL_SECONDS);
});

test('panel geom halves and quarters', () => {
  const g = panelGeom(1920, 1080);
  assert.equal(g.width50, 960);
  assert.equal(g.width25, 480);
  assert.equal(g.stripW, 960);
});

test('width expressions escape commas for filtergraph', () => {
  const g = panelGeom(1920, 1080);
  for (const expr of [widthExprA(g), widthExprB(g), widthExprC(g)]) {
    assert.ok(expr.includes('if(lt(t\\,'));
    // Every comma should be preceded by a backslash.
    assert.equal([...expr].filter((ch, i) => ch === ',' && expr[i - 1] !== '\\').length, 0);
  }
});
