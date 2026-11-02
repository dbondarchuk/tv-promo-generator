import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXmltv, parseXmltvDate } from './xmltv.js';

test('parseXmltvDate handles offset', () => {
  const d = parseXmltvDate('20240101180000 +0000');
  assert.equal(d.toISOString(), '2024-01-01T18:00:00.000Z');
});

test('parseXmltv extracts episode numbers', () => {
  const xml = `<?xml version="1.0"?>
  <tv>
    <channel id="1.etv"><display-name>SciFi</display-name></channel>
    <programme start="20240101180000 +0000" stop="20240101190000 +0000" channel="1.etv">
      <title>Star Trek: Enterprise</title>
      <sub-title>Shadows of P'Jem</sub-title>
      <episode-num system="onscreen">S01E15</episode-num>
      <episode-num system="xmltv_ns">0.14.0/1</episode-num>
    </programme>
  </tv>`;
  const guide = parseXmltv(xml);
  assert.equal(guide.programmes.length, 1);
  assert.equal(guide.programmes[0]!.title, 'Star Trek: Enterprise');
  assert.equal(guide.programmes[0]!.episodeTitle, "Shadows of P'Jem");
  assert.equal(guide.programmes[0]!.seasonNumber, 1);
  assert.equal(guide.programmes[0]!.episodeNumber, 15);
});
