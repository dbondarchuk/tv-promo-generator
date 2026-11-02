import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '@promo/shared';
import { buildEncoderPlan, escapeDrawtext } from './hwaccel.js';

test('None uses libx264', () => {
  const plan = buildEncoderPlan({ ...DEFAULT_SETTINGS, hardwareAcceleration: 'None' });
  assert.equal(plan.videoEncoder, 'libx264');
});

test('Nvenc uses h264_nvenc', () => {
  const plan = buildEncoderPlan({ ...DEFAULT_SETTINGS, hardwareAcceleration: 'Nvenc' });
  assert.equal(plan.videoEncoder, 'h264_nvenc');
  assert.deepEqual(plan.inputArgs.slice(0, 2), ['-hwaccel', 'cuda']);
});

test('Vaapi adds hwupload suffix', () => {
  const plan = buildEncoderPlan({ ...DEFAULT_SETTINGS, hardwareAcceleration: 'Vaapi' });
  assert.equal(plan.videoEncoder, 'h264_vaapi');
  assert.ok(plan.filterSuffix.includes('hwupload'));
});

test('escapeDrawtext escapes colon', () => {
  assert.equal(escapeDrawtext('A:B'), 'A\\:B');
});

test('escapeDrawtext replaces apostrophe with typographic mark', () => {
  assert.equal(escapeDrawtext("Stan's Best Friend"), 'Stan\u2019s Best Friend');
});
