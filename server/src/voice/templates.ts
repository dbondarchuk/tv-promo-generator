export type VoiceCue = 'next' | 'after';

export interface VoiceLineInput {
  channelName: string;
  title: string;
  episodeTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  /** First chapter = next; 2nd/3rd = after */
  cue?: VoiceCue;
}

export interface VoiceTemplate {
  language: string;
  voice: string;
  /** Lead-in only: "Next on {channel}." */
  next: (channelName: string) => string;
  /** Lead-in only: "After that." (no channel name) */
  after: (channelName: string) => string;
  /** On-screen: "Next: {item}" */
  overlayNext: (itemName: string) => string;
  /** On-screen: "After that: {item}" */
  overlayAfter: (itemName: string) => string;
  seasonEpisode: (s: number, e: number, name?: string) => string;
  startsAt: (hh: string, mm: string) => string;
}

export interface BuiltVoiceLine {
  /** Full line for logs / display */
  text: string;
  /** Cue, then show/episode — synthesized with a pause between parts */
  segments: string[];
  voice: string;
  language: string;
}

export const VOICE_TEMPLATES: Record<string, VoiceTemplate> = {
  en: {
    language: 'en',
    voice: 'en-US-GuyNeural',
    next: (c) => `Next on ${c}.`,
    after: () => 'After that.',
    overlayNext: (name) => `Next: ${name}`,
    overlayAfter: (name) => `After that: ${name}`,
    seasonEpisode: (s, e, name) => `Season ${s}, Episode ${e}${name ? `, ${name}` : ''}.`,
    startsAt: (hh, mm) => `Starts at ${hh}:${mm}`,
  },
  es: {
    language: 'es',
    voice: 'es-ES-AlvaroNeural',
    next: (c) => `A continuación en ${c}.`,
    after: () => 'Después.',
    overlayNext: (name) => `A continuación: ${name}`,
    overlayAfter: (name) => `Después: ${name}`,
    seasonEpisode: (s, e, name) => `Temporada ${s}, episodio ${e}${name ? `, ${name}` : ''}.`,
    startsAt: (hh, mm) => `Empieza a las ${hh}:${mm}`,
  },
  fr: {
    language: 'fr',
    voice: 'fr-FR-HenriNeural',
    next: (c) => `À suivre sur ${c}.`,
    after: () => 'Ensuite.',
    overlayNext: (name) => `À suivre : ${name}`,
    overlayAfter: (name) => `Ensuite : ${name}`,
    seasonEpisode: (s, e, name) => `Saison ${s}, épisode ${e}${name ? `, ${name}` : ''}.`,
    startsAt: (hh, mm) => `Commence à ${hh}:${mm}`,
  },
  de: {
    language: 'de',
    voice: 'de-DE-ConradNeural',
    next: (c) => `Als Nächstes auf ${c}.`,
    after: () => 'Danach.',
    overlayNext: (name) => `Als Nächstes: ${name}`,
    overlayAfter: (name) => `Danach: ${name}`,
    seasonEpisode: (s, e, name) => `Staffel ${s}, Folge ${e}${name ? `, ${name}` : ''}.`,
    startsAt: (hh, mm) => `Beginnt um ${hh}:${mm}`,
  },
  it: {
    language: 'it',
    voice: 'it-IT-DiegoNeural',
    next: (c) => `A seguire su ${c}.`,
    after: () => 'Dopo.',
    overlayNext: (name) => `A seguire: ${name}`,
    overlayAfter: (name) => `Dopo: ${name}`,
    seasonEpisode: (s, e, name) => `Stagione ${s}, episodio ${e}${name ? `, ${name}` : ''}.`,
    startsAt: (hh, mm) => `Inizia alle ${hh}:${mm}`,
  },
  pt: {
    language: 'pt',
    voice: 'pt-BR-AntonioNeural',
    next: (c) => `A seguir em ${c}.`,
    after: () => 'Depois disso.',
    overlayNext: (name) => `A seguir: ${name}`,
    overlayAfter: (name) => `Depois: ${name}`,
    seasonEpisode: (s, e, name) => `Temporada ${s}, episódio ${e}${name ? `, ${name}` : ''}.`,
    startsAt: (hh, mm) => `Começa às ${hh}:${mm}`,
  },
  ru: {
    language: 'ru',
    voice: 'ru-RU-DmitryNeural',
    next: (c) => `Далее на ${c}.`,
    after: () => 'После этого.',
    overlayNext: (name) => `Далее: ${name}`,
    overlayAfter: (name) => `После этого: ${name}`,
    seasonEpisode: (s, e, name) => `Сезон ${s}, серия ${e}${name ? `, ${name}` : ''}.`,
    startsAt: (hh, mm) => `Начало в ${hh}:${mm}`,
  },
  uk: {
    language: 'uk',
    voice: 'uk-UA-OstapNeural',
    next: (c) => `Далі на ${c}.`,
    after: () => 'Після цього.',
    overlayNext: (name) => `Далі: ${name}`,
    overlayAfter: (name) => `Після цього: ${name}`,
    seasonEpisode: (s, e, name) => `Сезон ${s}, серія ${e}${name ? `, ${name}` : ''}.`,
    startsAt: (hh, mm) => `Початок о ${hh}:${mm}`,
  },
  ukr: {
    language: 'uk',
    voice: 'uk-UA-OstapNeural',
    next: (c) => VOICE_TEMPLATES.uk!.next(c),
    after: (c) => VOICE_TEMPLATES.uk!.after(c),
    overlayNext: (name) => VOICE_TEMPLATES.uk!.overlayNext(name),
    overlayAfter: (name) => VOICE_TEMPLATES.uk!.overlayAfter(name),
    seasonEpisode: (s, e, name) => VOICE_TEMPLATES.uk!.seasonEpisode(s, e, name),
    startsAt: (hh, mm) => VOICE_TEMPLATES.uk!.startsAt(hh, mm),
  },
  pl: {
    language: 'pl',
    voice: 'pl-PL-MarekNeural',
    next: (c) => `Następnie na ${c}.`,
    after: () => 'Potem.',
    overlayNext: (name) => `Następnie: ${name}`,
    overlayAfter: (name) => `Potem: ${name}`,
    seasonEpisode: (s, e, name) => `Sezon ${s}, odcinek ${e}${name ? `, ${name}` : ''}.`,
    startsAt: (hh, mm) => `Start o ${hh}:${mm}`,
  },
  nl: {
    language: 'nl',
    voice: 'nl-NL-MaartenNeural',
    next: (c) => `Hierna op ${c}.`,
    after: () => 'Daarna.',
    overlayNext: (name) => `Hierna: ${name}`,
    overlayAfter: (name) => `Daarna: ${name}`,
    seasonEpisode: (s, e, name) => `Seizoen ${s}, aflevering ${e}${name ? `, ${name}` : ''}.`,
    startsAt: (hh, mm) => `Begint om ${hh}:${mm}`,
  },
  ja: {
    language: 'ja',
    voice: 'ja-JP-KeitaNeural',
    next: (c) => `このあと、${c}。`,
    after: () => 'そのあと。',
    overlayNext: (name) => `次: ${name}`,
    overlayAfter: (name) => `そのあと: ${name}`,
    seasonEpisode: (s, e, name) => `シーズン${s}、第${e}話${name ? `、${name}` : ''}。`,
    startsAt: (hh, mm) => `${hh}:${mm} 開始`,
  },
  zh: {
    language: 'zh',
    voice: 'zh-CN-YunxiNeural',
    next: (c) => `接下来在 ${c}。`,
    after: () => '之后。',
    overlayNext: (name) => `接下来: ${name}`,
    overlayAfter: (name) => `之后: ${name}`,
    seasonEpisode: (s, e, name) => `第${s}季第${e}集${name ? `，${name}` : ''}。`,
    startsAt: (hh, mm) => `${hh}:${mm} 开始`,
  },
  ko: {
    language: 'ko',
    voice: 'ko-KR-InJoonNeural',
    next: (c) => `다음 방송, ${c}.`,
    after: () => '그 다음에.',
    overlayNext: (name) => `다음: ${name}`,
    overlayAfter: (name) => `그 다음: ${name}`,
    seasonEpisode: (s, e, name) => `시즌 ${s}, ${e}화${name ? `, ${name}` : ''}.`,
    startsAt: (hh, mm) => `${hh}:${mm} 시작`,
  },
};

export function normalizeLanguage(code?: string): string {
  if (!code) return 'en';
  const lower = code.trim().toLowerCase().replace('_', '-');
  if (VOICE_TEMPLATES[lower]) return lower;
  const base = lower.split('-')[0] ?? 'en';
  if (VOICE_TEMPLATES[base]) return base;
  if (base === 'ua') return 'uk';
  return 'en';
}

export function getTemplate(language: string): VoiceTemplate {
  const key = normalizeLanguage(language);
  return VOICE_TEMPLATES[key] ?? VOICE_TEMPLATES.en!;
}

export function buildVoiceLine(language: string, input: VoiceLineInput): BuiltVoiceLine {
  const template = getTemplate(language);
  const cue: VoiceCue = input.cue === 'after' ? 'after' : 'next';
  const lead = cue === 'after'
    ? template.after(input.channelName)
    : template.next(input.channelName);
  const seasonLabel =
    input.seasonNumber != null && input.episodeNumber != null
      ? template.seasonEpisode(input.seasonNumber, input.episodeNumber, input.episodeTitle)
      : undefined;

  // Always announce the show/movie name; append season/episode when present.
  const title = input.title.trim();
  const detail = seasonLabel
    ? `${title}. ${seasonLabel}`
    : (input.episodeTitle && input.episodeTitle !== title
      ? `${title}. ${input.episodeTitle}`
      : title);
  const segments = detail ? [lead, detail] : [lead];

  return {
    text: segments.join(' '),
    segments,
    voice: template.voice,
    language: template.language,
  };
}

export function formatEpisodeSubtitle(
  language: string,
  seasonNumber?: number,
  episodeNumber?: number,
  episodeTitle?: string,
): string {
  const template = getTemplate(language);
  if (seasonNumber != null && episodeNumber != null) {
    // Strip trailing period for on-screen use
    return template.seasonEpisode(seasonNumber, episodeNumber, episodeTitle).replace(/\.$/, '');
  }

  return episodeTitle ?? '';
}

/** Lower-third headline: "Next: {item}" / "After that: {item}" */
export function formatOverlayHeadline(
  language: string,
  cue: VoiceCue,
  itemName: string,
): string {
  const template = getTemplate(language);

  return cue === 'after'
    ? template.overlayAfter(itemName)
    : template.overlayNext(itemName);
}

export function formatStartsAtLabel(language: string, date: Date): string {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');

  return getTemplate(language).startsAt(hh, mm);
}
