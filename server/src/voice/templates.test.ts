import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVoiceLine,
  formatEpisodeSubtitle,
  formatOverlayHeadline,
  formatStartsAtLabel,
  normalizeLanguage,
} from './templates.js';

test('normalizeLanguage maps ukr to uk', () => {
  assert.equal(normalizeLanguage('ukr'), 'ukr');
  assert.equal(buildVoiceLine('ukr', { channelName: 'SciFi', title: 'Show' }).language, 'uk');
});

test('Ukrainian next line is channel-first then season/episode', () => {
  const line = buildVoiceLine('uk', {
    channelName: 'SciFi',
    title: 'Star Trek',
    seasonNumber: 1,
    episodeNumber: 15,
    episodeTitle: "Shadows of P'Jem",
    cue: 'next',
  });
  assert.deepEqual(line.segments[0], 'Далі на SciFi.');
  assert.match(line.segments[1] ?? '', /^Star Trek\./);
  assert.match(line.segments[1] ?? '', /Сезон 1, серія 15/);
  assert.equal(line.segments.length, 2);
  assert.equal(line.voice, 'uk-UA-OstapNeural');
});

test('English next line is Next on {channel}', () => {
  const line = buildVoiceLine('en', {
    channelName: 'Futurama TV',
    title: 'Futurama',
    seasonNumber: 6,
    episodeNumber: 11,
    episodeTitle: 'Benderama',
    cue: 'next',
  });
  assert.equal(line.segments[0], 'Next on Futurama TV.');
  assert.match(line.segments[1] ?? '', /^Futurama\./);
  assert.match(line.segments[1] ?? '', /Season 6, Episode 11/);
});

test('Ukrainian after cue uses Після цього', () => {
  const line = buildVoiceLine('uk', {
    channelName: 'Futurama TV',
    title: 'Futurama',
    seasonNumber: 6,
    episodeNumber: 12,
    episodeTitle: 'The Mutants Are Revolting',
    cue: 'after',
  });
  assert.equal(line.segments[0], 'Після цього.');
  assert.doesNotMatch(line.segments[0] ?? '', /Futurama/);
  assert.doesNotMatch(line.text, /^Далі /);
});

test('English after cue uses After that', () => {
  const line = buildVoiceLine('en', {
    channelName: 'A',
    title: 'B',
    seasonNumber: 1,
    episodeNumber: 2,
    cue: 'after',
  });
  assert.equal(line.segments[0], 'After that.');
  assert.doesNotMatch(line.segments[0], /\bA\b/);
  assert.match(line.segments[1] ?? '', /^B\./);
  assert.match(line.segments[1] ?? '', /Season 1, Episode 2/);
});

test('overlay labels follow channel language', () => {
  assert.match(formatEpisodeSubtitle('uk', 6, 11, 'Benderama'), /Сезон 6, серія 11/);
  assert.match(formatStartsAtLabel('uk', new Date(2026, 0, 1, 14, 5)), /Початок о 14:05/);
  assert.match(formatStartsAtLabel('en', new Date(2026, 0, 1, 14, 5)), /Starts at 2:05 PM/);
  assert.match(
    formatStartsAtLabel('en', new Date('2026-01-01T19:05:00Z'), 'America/New_York'),
    /Starts at 2:05 PM/,
  );
  assert.match(formatEpisodeSubtitle('en', 6, 11, 'Benderama'), /Season 6, Episode 11/);
  assert.equal(formatOverlayHeadline('en', 'next', 'American Dad!'), 'Next: American Dad!');
  assert.equal(formatOverlayHeadline('en', 'after', 'Futurama'), 'After that: Futurama');
  assert.equal(formatOverlayHeadline('uk', 'next', 'Футурама'), 'Далі: Футурама');
});

test('voice cache key inputs are stable for English', () => {
  const a = buildVoiceLine('en', { channelName: 'A', title: 'B', seasonNumber: 1, episodeNumber: 2, cue: 'next' });
  const b = buildVoiceLine('en', { channelName: 'A', title: 'B', seasonNumber: 1, episodeNumber: 2, cue: 'next' });
  assert.equal(a.text, b.text);
});

test('showVoiceDetail controls episode announcement', () => {
  const base = {
    channelName: 'SciFi',
    title: 'Futurama',
    seasonNumber: 6,
    episodeNumber: 11,
    episodeTitle: 'Benderama',
    cue: 'next' as const,
  };

  assert.equal(
    buildVoiceLine('en', { ...base, showVoiceDetail: 'show' }).segments[1],
    'Futurama',
  );
  assert.equal(
    buildVoiceLine('en', { ...base, showVoiceDetail: 'show_episode' }).segments[1],
    'Futurama. Benderama',
  );
  assert.equal(
    buildVoiceLine('en', { ...base, showVoiceDetail: 'show_season_episode' }).segments[1],
    'Futurama. Season 6, Episode 11.',
  );
  assert.equal(
    buildVoiceLine('en', { ...base, showVoiceDetail: 'show_season_name' }).segments[1],
    'Futurama. Season 6, Benderama.',
  );
  assert.match(
    buildVoiceLine('en', { ...base, showVoiceDetail: 'show_season_episode_name' }).segments[1] ?? '',
    /^Futurama\. Season 6, Episode 11, Benderama\./,
  );
});
