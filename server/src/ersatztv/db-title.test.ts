import test from 'node:test';
import assert from 'node:assert/strict';
import { stripTitleYear } from './db.js';

test('stripTitleYear removes trailing parenthetical years', () => {
  assert.equal(stripTitleYear('Free Guy (2021)'), 'Free Guy');
  assert.equal(stripTitleYear('The Matrix (1999)'), 'The Matrix');
  assert.equal(stripTitleYear('American Pie [1999]'), 'American Pie');
  assert.equal(stripTitleYear('Futurama'), 'Futurama');
  assert.equal(stripTitleYear('2001: A Space Odyssey'), '2001: A Space Odyssey');
});
