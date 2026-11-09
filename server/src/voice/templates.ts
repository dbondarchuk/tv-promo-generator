import type { ShowVoiceDetail } from "@promo/shared";

export type VoiceCue = "next" | "after";

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

/**
 * Per-language copy for voice-over and on-screen/graphics overlays.
 * (Name is intentionally not voice-only.)
 */
export interface CopyTemplate {
  language: string;
  /** Preferred TTS voice id for this language (Piper / SAPI hint). */
  voice: string;
  /** Lead-in only: "Next on {channel}." */
  next: (channelName: string) => string;
  /** Lead-in only: "After that." (no channel name) */
  after: (channelName: string) => string;
  /** Graphics / on-screen: "Now on {channel}:" */
  nowOn: (channelName: string) => string;
  /** Graphics / on-screen: "Next on {channel}:" */
  nextOn: (channelName: string) => string;
  /** On-screen: "Now: {item}" */
  overlayNow: (itemName: string) => string;
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

export const COPY_TEMPLATES: Record<string, CopyTemplate> = {
  en: {
    language: "en",
    voice: "en-US-GuyNeural",
    next: (c) => `Next on ${c}.`,
    after: () => "After that.",
    nowOn: (c) => `Now on ${c}:`,
    nextOn: (c) => `Next on ${c}:`,
    overlayNow: (name) => `Now: ${name}`,
    overlayNext: (name) => `Next: ${name}`,
    overlayAfter: (name) => `After that: ${name}`,
    seasonEpisode: (s, e, name) =>
      `Season ${s}, Episode ${e}${name ? `, ${name}` : ""}.`,
    seasonName: (s, name) => `Season ${s}, ${name}.`,
    startsAt: (time) => `Starts at ${time}`,
  },
  es: {
    language: "es",
    voice: "es-ES-AlvaroNeural",
    next: (c) => `A continuación en ${c}.`,
    after: () => "Después.",
    nowOn: (c) => `Ahora en ${c}:`,
    nextOn: (c) => `A continuación en ${c}:`,
    overlayNow: (name) => `Ahora: ${name}`,
    overlayNext: (name) => `A continuación: ${name}`,
    overlayAfter: (name) => `Después: ${name}`,
    seasonEpisode: (s, e, name) =>
      `Temporada ${s}, episodio ${e}${name ? `, ${name}` : ""}.`,
    seasonName: (s, name) => `Temporada ${s}, ${name}.`,
    startsAt: (time) => `Empieza a las ${time}`,
  },
  fr: {
    language: "fr",
    voice: "fr-FR-HenriNeural",
    next: (c) => `À suivre sur ${c}.`,
    after: () => "Ensuite.",
    nowOn: (c) => `Maintenant sur ${c} :`,
    nextOn: (c) => `À suivre sur ${c} :`,
    overlayNow: (name) => `Maintenant : ${name}`,
    overlayNext: (name) => `À suivre : ${name}`,
    overlayAfter: (name) => `Ensuite : ${name}`,
    seasonEpisode: (s, e, name) =>
      `Saison ${s}, épisode ${e}${name ? `, ${name}` : ""}.`,
    seasonName: (s, name) => `Saison ${s}, ${name}.`,
    startsAt: (time) => `Commence à ${time}`,
  },
  de: {
    language: "de",
    voice: "de-DE-ConradNeural",
    next: (c) => `Als Nächstes auf ${c}.`,
    after: () => "Danach.",
    nowOn: (c) => `Jetzt auf ${c}:`,
    nextOn: (c) => `Als Nächstes auf ${c}:`,
    overlayNow: (name) => `Jetzt: ${name}`,
    overlayNext: (name) => `Als Nächstes: ${name}`,
    overlayAfter: (name) => `Danach: ${name}`,
    seasonEpisode: (s, e, name) =>
      `Staffel ${s}, Folge ${e}${name ? `, ${name}` : ""}.`,
    seasonName: (s, name) => `Staffel ${s}, ${name}.`,
    startsAt: (time) => `Beginnt um ${time}`,
  },
  it: {
    language: "it",
    voice: "it-IT-DiegoNeural",
    next: (c) => `A seguire su ${c}.`,
    after: () => "Dopo.",
    nowOn: (c) => `Ora su ${c}:`,
    nextOn: (c) => `A seguire su ${c}:`,
    overlayNow: (name) => `Ora: ${name}`,
    overlayNext: (name) => `A seguire: ${name}`,
    overlayAfter: (name) => `Dopo: ${name}`,
    seasonEpisode: (s, e, name) =>
      `Stagione ${s}, episodio ${e}${name ? `, ${name}` : ""}.`,
    seasonName: (s, name) => `Stagione ${s}, ${name}.`,
    startsAt: (time) => `Inizia alle ${time}`,
  },
  pt: {
    language: "pt",
    voice: "pt-BR-AntonioNeural",
    next: (c) => `A seguir em ${c}.`,
    after: () => "Depois disso.",
    nowOn: (c) => `Agora em ${c}:`,
    nextOn: (c) => `A seguir em ${c}:`,
    overlayNow: (name) => `Agora: ${name}`,
    overlayNext: (name) => `A seguir: ${name}`,
    overlayAfter: (name) => `Depois: ${name}`,
    seasonEpisode: (s, e, name) =>
      `Temporada ${s}, episódio ${e}${name ? `, ${name}` : ""}.`,
    seasonName: (s, name) => `Temporada ${s}, ${name}.`,
    startsAt: (time) => `Começa às ${time}`,
  },
  uk: {
    language: "uk",
    voice: "uk-UA-OstapNeural",
    next: (c) => `Далі на ${c}.`,
    after: () => "Після цього.",
    nowOn: (c) => `Зараз на ${c}:`,
    nextOn: (c) => `Далі на ${c}:`,
    overlayNow: (name) => `Зараз: ${name}`,
    overlayNext: (name) => `Далі: ${name}`,
    overlayAfter: (name) => `Після цього: ${name}`,
    seasonEpisode: (s, e, name) =>
      `Сезон ${s}, серія ${e}${name ? `, ${name}` : ""}.`,
    seasonName: (s, name) => `Сезон ${s}, ${name}.`,
    startsAt: (time) => `Початок о ${time}`,
  },
  ukr: {
    language: "uk",
    voice: "uk-UA-OstapNeural",
    next: (c) => COPY_TEMPLATES.uk!.next(c),
    after: (c) => COPY_TEMPLATES.uk!.after(c),
    nowOn: (c) => COPY_TEMPLATES.uk!.nowOn(c),
    nextOn: (c) => COPY_TEMPLATES.uk!.nextOn(c),
    overlayNow: (name) => COPY_TEMPLATES.uk!.overlayNow(name),
    overlayNext: (name) => COPY_TEMPLATES.uk!.overlayNext(name),
    overlayAfter: (name) => COPY_TEMPLATES.uk!.overlayAfter(name),
    seasonEpisode: (s, e, name) => COPY_TEMPLATES.uk!.seasonEpisode(s, e, name),
    seasonName: (s, name) => COPY_TEMPLATES.uk!.seasonName(s, name),
    startsAt: (time) => COPY_TEMPLATES.uk!.startsAt(time),
  },
  pl: {
    language: "pl",
    voice: "pl-PL-MarekNeural",
    next: (c) => `Następnie na ${c}.`,
    after: () => "Potem.",
    nowOn: (c) => `Teraz na ${c}:`,
    nextOn: (c) => `Następnie na ${c}:`,
    overlayNow: (name) => `Teraz: ${name}`,
    overlayNext: (name) => `Następnie: ${name}`,
    overlayAfter: (name) => `Potem: ${name}`,
    seasonEpisode: (s, e, name) =>
      `Sezon ${s}, odcinek ${e}${name ? `, ${name}` : ""}.`,
    seasonName: (s, name) => `Sezon ${s}, ${name}.`,
    startsAt: (time) => `Start o ${time}`,
  },
  nl: {
    language: "nl",
    voice: "nl-NL-MaartenNeural",
    next: (c) => `Hierna op ${c}.`,
    after: () => "Daarna.",
    nowOn: (c) => `Nu op ${c}:`,
    nextOn: (c) => `Hierna op ${c}:`,
    overlayNow: (name) => `Nu: ${name}`,
    overlayNext: (name) => `Hierna: ${name}`,
    overlayAfter: (name) => `Daarna: ${name}`,
    seasonEpisode: (s, e, name) =>
      `Seizoen ${s}, aflevering ${e}${name ? `, ${name}` : ""}.`,
    seasonName: (s, name) => `Seizoen ${s}, ${name}.`,
    startsAt: (time) => `Begint om ${time}`,
  },
  ja: {
    language: "ja",
    voice: "ja-JP-KeitaNeural",
    next: (c) => `このあと、${c}。`,
    after: () => "そのあと。",
    nowOn: (c) => `ただいま、${c}:`,
    nextOn: (c) => `このあと、${c}:`,
    overlayNow: (name) => `現在: ${name}`,
    overlayNext: (name) => `次: ${name}`,
    overlayAfter: (name) => `そのあと: ${name}`,
    seasonEpisode: (s, e, name) =>
      `シーズン${s}、第${e}話${name ? `、${name}` : ""}。`,
    seasonName: (s, name) => `シーズン${s}、${name}。`,
    startsAt: (time) => `${time} 開始`,
  },
  zh: {
    language: "zh",
    voice: "zh-CN-YunxiNeural",
    next: (c) => `接下来在 ${c}。`,
    after: () => "之后。",
    nowOn: (c) => `正在播放 · ${c}:`,
    nextOn: (c) => `接下来在 ${c}:`,
    overlayNow: (name) => `现在: ${name}`,
    overlayNext: (name) => `接下来: ${name}`,
    overlayAfter: (name) => `之后: ${name}`,
    seasonEpisode: (s, e, name) =>
      `第${s}季第${e}集${name ? `，${name}` : ""}。`,
    seasonName: (s, name) => `第${s}季，${name}。`,
    startsAt: (time) => `${time} 开始`,
  },
  ko: {
    language: "ko",
    voice: "ko-KR-InJoonNeural",
    next: (c) => `다음 방송, ${c}.`,
    after: () => "그 다음에.",
    nowOn: (c) => `지금 ${c}:`,
    nextOn: (c) => `다음 방송, ${c}:`,
    overlayNow: (name) => `지금: ${name}`,
    overlayNext: (name) => `다음: ${name}`,
    overlayAfter: (name) => `그 다음: ${name}`,
    seasonEpisode: (s, e, name) =>
      `시즌 ${s}, ${e}화${name ? `, ${name}` : ""}.`,
    seasonName: (s, name) => `시즌 ${s}, ${name}.`,
    startsAt: (time) => `${time} 시작`,
  },
};

export function normalizeLanguage(code?: string): string {
  if (!code) return "en";

  const lower = code.trim().toLowerCase().replace("_", "-");
  if (COPY_TEMPLATES[lower]) return lower;

  const base = lower.split("-")[0] ?? "en";
  if (COPY_TEMPLATES[base]) return base;
  if (base === "ua") return "uk";

  return "en";
}

export function getCopyTemplate(language: string): CopyTemplate {
  const key = normalizeLanguage(language);
  return COPY_TEMPLATES[key] ?? COPY_TEMPLATES.en!;
}

function buildShowDetail(
  template: CopyTemplate,
  input: VoiceLineInput,
  mode: ShowVoiceDetail,
): string {
  const title = input.title.trim();
  if (!title) return "";

  const hasSeasonEp = input.seasonNumber != null && input.episodeNumber != null;
  const episodeName =
    input.episodeTitle?.trim() && input.episodeTitle.trim() !== title
      ? input.episodeTitle.trim()
      : undefined;

  // Movies / items without S/E: speak the title only (optionally episode title if present).
  if (!hasSeasonEp) {
    if (
      (mode === "show_episode" ||
        mode === "show_season_name" ||
        mode === "show_season_episode_name") &&
      episodeName
    ) {
      return `${title}. ${episodeName}`;
    }

    return title;
  }

  switch (mode) {
    case "show":
      return title;
    case "show_episode":
      return episodeName ? `${title}. ${episodeName}` : title;
    case "show_season_episode":
      return `${title}. ${template.seasonEpisode(input.seasonNumber!, input.episodeNumber!)}`;
    case "show_season_name":
      return episodeName
        ? `${title}. ${template.seasonName(input.seasonNumber!, episodeName)}`
        : `${title}. ${template.seasonEpisode(input.seasonNumber!, input.episodeNumber!)}`;
    case "show_season_episode_name":
    default:
      return `${title}. ${template.seasonEpisode(
        input.seasonNumber!,
        input.episodeNumber!,
        episodeName,
      )}`;
  }
}

export function buildVoiceLine(
  language: string,
  input: VoiceLineInput,
): BuiltVoiceLine {
  const template = getCopyTemplate(language);
  const cue: VoiceCue = input.cue === "after" ? "after" : "next";
  const lead =
    cue === "after"
      ? template.after(input.channelName)
      : template.next(input.channelName);

  const mode = input.showVoiceDetail ?? "show_season_episode_name";
  const detail = buildShowDetail(template, input, mode);
  const segments = detail ? [lead, detail] : [lead];

  return {
    text: segments.join(" "),
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
  const template = getCopyTemplate(language);
  if (seasonNumber != null && episodeNumber != null) {
    // Strip trailing period for on-screen use
    return template
      .seasonEpisode(seasonNumber, episodeNumber, episodeTitle)
      .replace(/\.$/, "");
  }

  return episodeTitle ?? "";
}

/** Lower-third headline: "Next: {item}" / "After that: {item}" */
export function formatOverlayHeadline(
  language: string,
  cue: VoiceCue,
  itemName: string,
): string {
  const template = getCopyTemplate(language);

  return cue === "after"
    ? template.overlayAfter(itemName)
    : template.overlayNext(itemName);
}

function localeForLanguage(language: string): string {
  switch (normalizeLanguage(language)) {
    case "es":
      return "es-ES";
    case "fr":
      return "fr-FR";
    case "de":
      return "de-DE";
    case "it":
      return "it-IT";
    case "pt":
      return "pt-BR";
    case "uk":
      return "uk-UA";
    case "pl":
      return "pl-PL";
    case "nl":
      return "nl-NL";
    case "ja":
      return "ja-JP";
    case "zh":
      return "zh-CN";
    case "ko":
      return "ko-KR";
    case "en":
    default:
      return "en-US";
  }
}

/** English (and similar) get 12h + AM/PM; most others stay 24h. */
function preferHour12(language: string): boolean {
  return normalizeLanguage(language) === "en";
}

/** Wall-clock time in the configured IANA timezone (empty = runtime default). */
export function formatWallClock(
  date: Date,
  language: string,
  timeZone?: string,
): string {
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: preferHour12(language),
  };

  const zone = timeZone?.trim();
  if (zone) options.timeZone = zone;

  try {
    return new Intl.DateTimeFormat(localeForLanguage(language), options).format(
      date,
    );
  } catch {
    // Invalid IANA zone — fall back to runtime default.
    delete options.timeZone;
    return new Intl.DateTimeFormat(localeForLanguage(language), options).format(
      date,
    );
  }
}

export function formatStartsAtLabel(
  language: string,
  date: Date,
  timeZone?: string,
): string {
  return getCopyTemplate(language).startsAt(
    formatWallClock(date, language, timeZone),
  );
}
