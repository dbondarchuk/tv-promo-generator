import { createLogger } from '../util/log.js';

export interface EtvApiChannel {
  id: number;
  number: string;
  name: string;
  fFmpegProfile?: string;
  language?: string;
  preferredAudioLanguageCode?: string;
  streamingMode?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const log = createLogger('etv-api');

export class EtvApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private url(pathname: string): string {
    return new URL(pathname, this.baseUrl.endsWith('/') ? this.baseUrl : `${this.baseUrl}/`).toString();
  }

  private headers(json = false): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.apiKey) headers['X-Etv-Api-Key'] = this.apiKey;
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private async fetchWithTimeout(pathname: string, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? 'GET';
    const started = Date.now();
    log.debug(`${method} ${pathname} start`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.url(pathname), {
        ...init,
        headers: { ...this.headers(Boolean(init?.body)), ...(init?.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      });
      log.debug(`${method} ${pathname} done`, { status: res.status, ms: Date.now() - started });
      return res;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        log.error(`${method} ${pathname} timed out`, { ms: this.timeoutMs });
        throw new Error(`Request timed out after ${this.timeoutMs}ms: ${pathname}`);
      }
      log.error(`${method} ${pathname} failed`, err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async getText(pathname: string): Promise<string> {
    const res = await this.fetchWithTimeout(pathname);
    if (!res.ok) {
      throw new Error(`GET ${pathname} failed: ${res.status} ${res.statusText}`);
    }
    return res.text();
  }

  async getJson<T>(pathname: string): Promise<T> {
    const res = await this.fetchWithTimeout(pathname);
    if (!res.ok) {
      throw new Error(`GET ${pathname} failed: ${res.status} ${res.statusText}`);
    }
    return res.json() as Promise<T>;
  }

  async post(pathname: string, body?: unknown): Promise<void> {
    const res = await this.fetchWithTimeout(pathname, {
      method: 'POST',
      body: body !== undefined ? JSON.stringify(body) : '',
    });
    if (!res.ok) {
      throw new Error(`POST ${pathname} failed: ${res.status} ${res.statusText}`);
    }
  }

  getM3u(): Promise<string> {
    return this.getText('iptv/channels.m3u');
  }

  getXmltv(): Promise<string> {
    return this.getText('iptv/xmltv.xml');
  }

  getChannels(): Promise<EtvApiChannel[]> {
    return this.getJson<EtvApiChannel[]>('api/channels');
  }

  scanLibrary(id: number): Promise<void> {
    return this.post(`api/libraries/${id}/scan`);
  }

  resetPlayout(channelNumber: string): Promise<void> {
    return this.post(`api/channels/${encodeURIComponent(channelNumber)}/playout/reset`);
  }
}
