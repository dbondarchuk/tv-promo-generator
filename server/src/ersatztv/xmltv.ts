import { XMLParser } from 'fast-xml-parser';

export interface XmltvProgramme {
  channelId: string;
  start: Date;
  stop: Date;
  title: string;
  episodeTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  description?: string;
}

export interface XmltvChannel {
  id: string;
  displayName: string;
  iconUrl?: string;
}

export interface XmltvGuide {
  channels: XmltvChannel[];
  programmes: XmltvProgramme[];
}

export function parseXmltv(xml: string): XmltvGuide {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    isArray: (name) => ['channel', 'programme', 'display-name', 'icon', 'title', 'sub-title', 'desc', 'episode-num'].includes(name),
  });
  const doc = parser.parse(xml);
  const tv = doc.tv ?? {};
  const channels: XmltvChannel[] = (tv.channel ?? []).map((ch: any) => {
    const names = ch['display-name'] ?? [];
    const icons = ch.icon ?? [];
    return {
      id: String(ch['@_id'] ?? ''),
      displayName: textOf(names[0]) || String(ch['@_id'] ?? ''),
      iconUrl: icons[0]?.['@_src'] ? String(icons[0]['@_src']) : undefined,
    };
  });

  const programmes: XmltvProgramme[] = (tv.programme ?? []).map((p: any) => {
    const titles = p.title ?? [];
    const subtitles = p['sub-title'] ?? [];
    const descs = p.desc ?? [];
    const episodeNums = p['episode-num'] ?? [];
    const { season, episode } = parseEpisodeNumbers(episodeNums);
    return {
      channelId: String(p['@_channel'] ?? ''),
      start: parseXmltvDate(String(p['@_start'] ?? '')),
      stop: parseXmltvDate(String(p['@_stop'] ?? '')),
      title: textOf(titles[0]) || 'Unknown',
      episodeTitle: textOf(subtitles[0]) || undefined,
      seasonNumber: season,
      episodeNumber: episode,
      description: textOf(descs[0]) || undefined,
    };
  });

  return { channels, programmes };
}

function textOf(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (typeof node === 'object' && node !== null && '#text' in node) {
    return String((node as { '#text': unknown })['#text'] ?? '');
  }
  return '';
}

export function parseXmltvDate(value: string): Date {
  // 20240101180000 +0000 or 20240101180000
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/.exec(value.trim());
  if (!m) return new Date(NaN);
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ? formatOffset(m[7]) : 'Z'}`;
  return new Date(iso);
}

function formatOffset(offset: string): string {
  return `${offset.slice(0, 3)}:${offset.slice(3)}`;
}

function parseEpisodeNumbers(nodes: any[]): { season?: number; episode?: number } {
  let season: number | undefined;
  let episode: number | undefined;
  for (const node of nodes) {
    const system = String(node?.['@_system'] ?? '').toLowerCase();
    const text = textOf(node);
    if (system === 'xmltv_ns') {
      // season-1.episode-1.part/total  (zero-based)
      const parts = text.split('.');
      if (parts[0]) {
        const s = Number(parts[0].split('/')[0]);
        if (Number.isFinite(s)) season = s + 1;
      }
      if (parts[1]) {
        const e = Number(parts[1].split('/')[0]);
        if (Number.isFinite(e)) episode = e + 1;
      }
    } else if (/^S\d+E\d+/i.test(text)) {
      const m = /^S(\d+)E(\d+)/i.exec(text);
      if (m) {
        season = Number(m[1]);
        episode = Number(m[2]);
      }
    }
  }
  return { season, episode };
}

export function upcomingProgrammes(
  programmes: XmltvProgramme[],
  channelId: string,
  after: Date,
  limit = 3,
): XmltvProgramme[] {
  return programmes
    .filter((p) => p.channelId === channelId && p.start.getTime() >= after.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, limit);
}
