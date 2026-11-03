import assert from 'node:assert/strict';
import test from 'node:test';
import { audioStreamMatchesLanguage, pickAudioStreamForLanguage } from './probe.js';

test('audioStreamMatchesLanguage maps ISO aliases', () => {
  assert.equal(audioStreamMatchesLanguage('ukr', 'uk'), true);
  assert.equal(audioStreamMatchesLanguage('ua', 'uk'), true);
  assert.equal(audioStreamMatchesLanguage('eng', 'en'), true);
  assert.equal(audioStreamMatchesLanguage('en-US', 'en'), true);
  assert.equal(audioStreamMatchesLanguage('rus', 'uk'), false);
  assert.equal(audioStreamMatchesLanguage(undefined, 'en'), false);
});

test('pickAudioStreamForLanguage prefers matching language', () => {
  const streams = [
    { audioIndex: 0, language: 'eng', isDefault: true },
    { audioIndex: 1, language: 'ukr', isDefault: false },
  ];
  assert.equal(pickAudioStreamForLanguage(streams, 'uk')?.audioIndex, 1);
  assert.equal(pickAudioStreamForLanguage(streams, 'en')?.audioIndex, 0);
});

test('pickAudioStreamForLanguage falls back to default then first', () => {
  const streams = [
    { audioIndex: 0, language: 'eng', isDefault: false },
    { audioIndex: 1, language: 'deu', isDefault: true },
  ];
  assert.equal(pickAudioStreamForLanguage(streams, 'uk')?.audioIndex, 1);
  assert.equal(
    pickAudioStreamForLanguage(
      [
        { audioIndex: 0, language: 'eng', isDefault: false },
        { audioIndex: 1, language: 'fra', isDefault: false },
      ],
      'uk',
    )?.audioIndex,
    0,
  );
});
