import type { ShowVoiceDetail } from '@promo/shared';

export type VoiceCue = 'next' | 'after';

export interface VoiceLineInput {
  channelName: string;
  title: string;
  episodeTitle?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  /** First chapter = next; 2nd/3rd = after */
  cue?: VoiceCue;
  /** Episode detail level for voice-over (movies ignore this). */
  showVoiceDetail?: ShowVoiceDetail;
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
  /** Season + episode title only (no episode number). */
  seasonName: (s: number, name: string) => string;
  /** `time` is already localized (e.g. "8:05 PM" or "20:05"). */
  startsAt: (time: string) => string;
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
    seasonName: (s, name) => `Season ${s}, ${name}.`,
    startsAt: (time) => `Starts at ${time}`,
  },
  es: {
    language: 'es',
    voice: 'es-ES-AlvaroNeural',
    next: (c) => `A continuación en ${c}.`,
    after: () => 'Después.',
    overlayNext: (name) => `A continuación: ${name}`,
    overlayAfter: (name) => `Después: ${name}`,
    seasonEpisode: (s, e, name) => `Temporada ${s}, episodio ${e}${name ? `, ${name}` : ''}.`,
    seasonName: (s, name) => `Temporada ${s}, ${name}.`,
    startsAt: (time) => `Empieza a las ${time}`,
  },
  fr: {
    language: 'fr',
    voice: 'fr-FR-HenriNeural',
    next: (c) => `À suivre sur ${c}.`,
    after: () => 'Ensuite.',
    overlayNext: (name) => `À suivre : ${name}`,
    overlayAfter: (name) => `Ensuite : ${name}`,
    seasonEpisode: (s, e, name) => `Saison ${s}, épisode ${e}${name ? `, ${name}` : ''}.`,
    seasonName: (s, name) => `Saison ${s}, ${name}.`,
    startsAt: (time) => `Commence à ${time}`,
  },
  de: {
    language: 'de',
    voice: 'de-DE-ConradNeural',
    next: (c) => `Als Nächstes auf ${c}.`,
    after: () => 'Danach.',
    overlayNext: (name) => `Als Nächstes: ${name}`,
    overlayAfter: (name) => `Danach: ${name}`,
    seasonEpisode: (s, e, name) => `Staffel ${s}, Folge ${e}${name ? `, ${name}` : ''}.`,
    seasonName: (s, name) => `Staffel ${s}, ${name}.`,
    startsAt: (time) => `Beginnt um ${time}`,
  },
  it: {
    language: 'it',
    voice: 'it-IT-DiegoNeural',
    next: (c) => `A seguire su ${c}.`,
    after: () => 'Dopo.',
    overlayNext: (name) => `A seguire: ${name}`,
    overlayAfter: (name) => `Dopo: ${name}`,
    seasonEpisode: (s, e, name) => `Stagione ${s}, episodio ${e}${name ? `, ${name}` : ''}.`,
    seasonName: (s, name) => `Stagione ${s}, ${name}.`,
    startsAt: (time) => `Inizia alle ${time}`,
  },
  pt: {
    language: 'pt',
    voice: 'pt-BR-AntonioNeural',
    next: (c) => `A seguir em ${c}.`,
    after: () => 'Depois disso.',
    overlayNext: (name) => `A seguir: ${name}`,
    overlayAfter: (name) => `Depois: ${name}`,
    seasonEpisode: (s, e, name) => `Temporada ${s}, episódio ${e}${name ? `, ${name}` : ''}.`,
    seasonName: (s, name) => `Temporada ${s}, ${name}.`,
    startsAt: (time) => `Começa às ${time}`,
  },
  ru: {
    language: 'ru',
    voice: 'ru-RU-DmitryNeural',
    next: (c) => `Далее на ${c}.`,
    after: () => 'После этого.',
    overlayNext: (name) => `Далее: ${name}`,
    overlayAfter: (name) => `После этого: ${name}`,
    seasonEpisode: (s, e, name) => `Сезон ${s}, серия ${e}${name ? `, ${name}` : ''}.`,
    seasonName: (s, name) => `Сезон ${s}, ${name}.`,
    startsAt: (time) => `Начало в ${time}`,
  },
  uk: {
    language: 'uk',
    voice: 'uk-UA-OstapNeural',
    next: (c) => `Далі на ${c}.`,
    after: () => 'Після цього.',
    overlayNext: (name) => `Далі: ${name}`,
    overlayAfter: (name) => `Після цього: ${name}`,
    seasonEpisode: (s, e, name) => `Сезон ${s}, серія ${e}${name ? `, ${name}` : ''}.`,
    seasonName: (s, name) => `Сезон ${s}, ${name}.`,
    startsAt: (time) => `Початок о ${time}`,
  },
  ukr: {
    language: 'uk',
    voice: 'uk-UA-OstapNeural',
    next: (c) => VOICE_TEMPLATES.uk!.next(c),
    after: (c) => VOICE_TEMPLATES.uk!.after(c),
    overlayNext: (name) => VOICE_TEMPLATES.uk!.overlayNext(name),
    overlayAfter: (name) => VOICE_TEMPLATES.uk!.overlayAfter(name),
    seasonEpisode: (s, e, name) => VOICE_TEMPLATES.uk!.seasonEpisode(s, e, name),
    seasonName: (s, name) => VOICE_TEMPLATES.uk!.seasonName(s, name),
    startsAt: (time) => VOICE_TEMPLATES.uk!.startsAt(time),
  },
  pl: {
    language: 'pl',
    voice: 'pl-PL-MarekNeural',
    next: (c) => `Następnie na ${c}.`,
    after: () => 'Potem.',
    overlayNext: (name) => `Następnie: ${name}`,
    overlayAfter: (name) => `Potem: ${name}`,
    seasonEpisode: (s, e, name) => `Sezon ${s}, odcinek ${e}${name ? `, ${name}` : ''}.`,
    seasonName: (s, name) => `Sezon ${s}, ${name}.`,
    startsAt: (time) => `Start o ${time}`,
  },
  nl: {
    language: 'nl',
    voice: 'nl-NL-MaartenNeural',
    next: (c) => `Hierna op ${c}.`,
    after: () => 'Daarna.',
    overlayNext: (name) => `Hierna: ${name}`,
    overlayAfter: (name) => `Daarna: ${name}`,
    seasonEpisode: (s, e, name) => `Seizoen ${s}, aflevering ${e}${name ? `, ${name}` : ''}.`,
    seasonName: (s, name) => `Seizoen ${s}, ${name}.`,
    startsAt: (time) => `Begint om ${time}`,
  },
  ja: {
    language: 'ja',
    voice: 'ja-JP-KeitaNeural',
    next: (c) => `このあと、${c}。`,
    after: () => 'そのあと。',
    overlayNext: (name) => `次: ${name}`,
    overlayAfter: (name) => `そのあと: ${name}`,
    seasonEpisode: (s, e, name) => `シーズン${s}、第${e}話${name ? `、${name}` : ''}。`,
    seasonName: (s, name) => `シーズン${s}、${name}。`,
    startsAt: (time) => `${time} 開始`,
  },
  zh: {
    language: 'zh',
    voice: 'zh-CN-YunxiNeural',
    next: (c) => `接下来在 ${c}。`,
    after: () => '之后。',
    overlayNext: (name) => `接下来: ${name}`,
    overlayAfter: (name) => `之后: ${name}`,
    seasonEpisode: (s, e, name) => `第${s}季第${e}集${name ? `，${name}` : ''}。`,
    seasonName: (s, name) => `第${s}季，${name}。`,
    startsAt: (time) => `${time} 开始`,
  },
  ko: {
    language: 'ko',
    voice: 'ko-KR-InJoonNeural',
    next: (c) => `다음 방송, ${c}.`,
    after: () => '그 다음에.',
    overlayNext: (name) => `다음: ${name}`,
    overlayAfter: (name) => `그 다음: ${name}`,
    seasonEpisode: (s, e, name) => `시즌 ${s}, ${e}화${name ? `, ${name}` : ''}.`,
    seasonName: (s, name) => `시즌 ${s}, ${name}.`,
    startsAt: (time) => `${time} 시작`,
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

function buildShowDetail(
  template: VoiceTemplate,
  input: VoiceLineInput,
  mode: ShowVoiceDetail,
): string {
  const title = input.title.trim();
  if (!title) return '';

  const hasSeasonEp = input.seasonNumber != null && input.episodeNumber != null;
  const episodeName =
    input.episodeTitle?.trim() && input.episodeTitle.trim() !== title
      ? input.episodeTitle.trim()
      : undefined;

  // Movies / items without S/E: speak the title only (optionally episode title if present).
  if (!hasSeasonEp) {
    if (
      (mode === 'show_episode' ||
        mode === 'show_season_name' ||
        mode === 'show_season_episode_name') &&
      episodeName
    ) {
      return `${title}. ${episodeName}`;
    }
    return title;
  }

  switch (mode) {
    case 'show':
      return title;
    case 'show_episode':
      return episodeName ? `${title}. ${episodeName}` : title;
    case 'show_season_episode':
      return `${title}. ${template.seasonEpisode(input.seasonNumber!, input.episodeNumber!)}`;
    case 'show_season_name':
      return episodeName
        ? `${title}. ${template.seasonName(input.seasonNumber!, episodeName)}`
        : `${title}. ${template.seasonEpisode(input.seasonNumber!, input.episodeNumber!)}`;
    case 'show_season_episode_name':
    default:
      return `${title}. ${template.seasonEpisode(
        input.seasonNumber!,
        input.episodeNumber!,
        episodeName,
      )}`;
  }
}

export function buildVoiceLine(language: string, input: VoiceLineInput): BuiltVoiceLine {
  const template = getTemplate(language);
  const cue: VoiceCue = input.cue === 'after' ? 'after' : 'next';
  const lead = cue === 'after'
    ? template.after(input.channelName)
    : template.next(input.channelName);
  const mode = input.showVoiceDetail ?? 'show_season_episode_name';
  const detail = buildShowDetail(template, input, mode);
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

function localeForLanguage(language: string): string {
  switch (normalizeLanguage(language)) {
    case 'es':
      return 'es-ES';
    case 'fr':
      return 'fr-FR';
    case 'de':
      return 'de-DE';
    case 'it':
      return 'it-IT';
    case 'pt':
      return 'pt-BR';
    case 'ru':
      return 'ru-RU';
    case 'uk':
      return 'uk-UA';
    case 'pl':
      return 'pl-PL';
    case 'nl':
      return 'nl-NL';
    case 'ja':
      return 'ja-JP';
    case 'zh':
      return 'zh-CN';
    case 'ko':
      return 'ko-KR';
    case 'en':
    default:
      return 'en-US';
  }
}

/** English (and similar) get 12h + AM/PM; most others stay 24h. */
function preferHour12(language: string): boolean {
  return normalizeLanguage(language) === 'en';
}

/** Wall-clock time in the configured IANA timezone (empty = runtime default). */
export function formatWallClock(date: Date, language: string, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    hour12: preferHour12(language),
  };
  const zone = timeZone?.trim();
  if (zone) options.timeZone = zone;

  try {
    return new Intl.DateTimeFormat(localeForLanguage(language), options).format(date);
  } catch {
    // Invalid IANA zone — fall back to runtime default.
    delete options.timeZone;
    return new Intl.DateTimeFormat(localeForLanguage(language), options).format(date);
  }
}

export function formatStartsAtLabel(language: string, date: Date, timeZone?: string): string {
  return getTemplate(language).startsAt(formatWallClock(date, language, timeZone));
}
