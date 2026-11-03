import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '../util/log.js';

const log = createLogger('wyoming');

export interface WyomingVoice {
  name: string;
  languages: string[];
  description?: string;
  speakers?: Array<{ name: string }>;
}

export interface WyomingSynthResult {
  pcm: Buffer;
  rate: number;
  width: number;
  channels: number;
  voice: string;
}

interface ParsedEvent {
  type: string;
  data: Record<string, unknown>;
  payload?: Buffer;
}

function parseHostPort(urlOrHost: string, defaultPort = 10200): { host: string; port: number } {
  const raw = urlOrHost.trim().replace(/\/+$/, '');
  try {
    if (/^https?:\/\//i.test(raw)) {
      const u = new URL(raw);
      return { host: u.hostname, port: u.port ? Number(u.port) : defaultPort };
    }
  } catch {
    // fall through
  }
  const [host, portStr] = raw.split(':');
  return { host: host || '127.0.0.1', port: portStr ? Number(portStr) : defaultPort };
}

function sendEvent(
  socket: net.Socket,
  type: string,
  data: Record<string, unknown> = {},
  payload?: Buffer,
): void {
  const dataJson = Buffer.from(JSON.stringify(data), 'utf8');
  const header: Record<string, unknown> = {
    type,
    data_length: dataJson.length,
    payload_length: payload?.length ?? null,
  };
  socket.write(`${JSON.stringify(header)}\n`);
  if (dataJson.length > 0) socket.write(dataJson);
  if (payload && payload.length > 0) socket.write(payload);
}

class WyomingReader {
  private buffer = Buffer.alloc(0);
  private waitingData = 0;
  private waitingPayload = 0;
  private header: { type: string; dataLength: number; payloadLength: number } | null = null;
  private dataBuf = Buffer.alloc(0);
  private readonly queue: ParsedEvent[] = [];
  private waiters: Array<() => void> = [];

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.pump();
  }

  private wake(): void {
    const waiters = this.waiters.splice(0);
    for (const w of waiters) w();
  }

  private enqueue(evt: ParsedEvent): void {
    this.queue.push(evt);
    this.wake();
  }

  private pump(): void {
    while (true) {
      if (this.header && this.waitingData > 0) {
        if (this.buffer.length < this.waitingData) return;
        this.dataBuf = this.buffer.subarray(0, this.waitingData);
        this.buffer = this.buffer.subarray(this.waitingData);
        this.waitingData = 0;
        if (this.waitingPayload > 0) continue;
        this.finishEvent();
        continue;
      }

      if (this.header && this.waitingPayload > 0) {
        if (this.buffer.length < this.waitingPayload) return;
        const payload = this.buffer.subarray(0, this.waitingPayload);
        this.buffer = this.buffer.subarray(this.waitingPayload);
        this.waitingPayload = 0;
        this.finishEvent(payload);
        continue;
      }

      const nl = this.buffer.indexOf(0x0a);
      if (nl < 0) return;
      const line = this.buffer.subarray(0, nl).toString('utf8').trim();
      this.buffer = this.buffer.subarray(nl + 1);
      if (!line) continue;
      let header: Record<string, unknown>;
      try {
        header = JSON.parse(line) as Record<string, unknown>;
      } catch {
        log.warn('wyoming bad header line', line.slice(0, 120));
        continue;
      }
      const type = String(header.type ?? '');
      const dataLength = Number(header.data_length ?? 0) || 0;
      const payloadLength = Number(header.payload_length ?? 0) || 0;
      this.header = { type, dataLength, payloadLength };
      this.dataBuf = Buffer.alloc(0);
      this.waitingData = dataLength;
      this.waitingPayload = payloadLength;
      if (dataLength === 0 && payloadLength === 0) {
        this.finishEvent();
      }
    }
  }

  private finishEvent(payload?: Buffer): void {
    if (!this.header) return;
    let data: Record<string, unknown> = {};
    if (this.dataBuf.length > 0) {
      try {
        data = JSON.parse(this.dataBuf.toString('utf8')) as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    const evt = { type: this.header.type, data, payload };
    this.header = null;
    this.enqueue(evt);
  }

  async next(timeoutMs: number): Promise<ParsedEvent> {
    if (this.queue.length > 0) return this.queue.shift()!;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== resolve);
        reject(new Error(`Wyoming timed out after ${timeoutMs}ms waiting for event`));
      }, timeoutMs);
      const wrapped = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wrapped);
    });
    if (this.queue.length === 0) {
      throw new Error('Wyoming event queue empty after wake');
    }
    return this.queue.shift()!;
  }
}

function writeWav(filePath: string, pcm: Buffer, rate: number, width: number, channels: number): void {
  const blockAlign = channels * width;
  const byteRate = rate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(width * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

export function pickPiperVoice(
  voices: WyomingVoice[],
  language: string,
  preferred?: string,
): string | undefined {
  if (preferred && voices.some((v) => v.name === preferred)) return preferred;
  if (preferred) return preferred; // allow explicit override even if describe is stale

  const lang = language.trim().toLowerCase().replace('_', '-');
  const base = lang.split('-')[0] ?? 'en';
  const candidates = voices.filter((v) =>
    (v.languages ?? []).some((l) => {
      const ll = l.toLowerCase().replace('_', '-');
      return ll === lang || ll.startsWith(`${base}-`) || ll === base;
    }),
  );
  if (candidates.length === 0) return undefined;

  const score = (name: string): number => {
    let s = 0;
    if (/-high$/.test(name)) s += 30;
    else if (/-medium$/.test(name)) s += 20;
    else if (/-low$/.test(name)) s += 10;
    else if (/-x_low$/.test(name)) s += 5;
    // Prefer male promo-ish voices when available.
    if (/oleksa|mykyta|ryan|lessac|joe|john|alan|thorsten|dmitri|denis|ruslan/.test(name)) s += 5;
    return s;
  };

  return [...candidates].sort((a, b) => score(b.name) - score(a.name))[0]?.name;
}

export async function listWyomingVoices(
  urlOrHost: string,
  timeoutMs = 10_000,
): Promise<WyomingVoice[]> {
  const { host, port } = parseHostPort(urlOrHost);
  return await withSocket(host, port, timeoutMs, async (socket, reader) => {
    sendEvent(socket, 'describe');
    while (true) {
      const evt = await reader.next(timeoutMs);
      if (evt.type === 'info') {
        const tts = (evt.data.tts as Array<{ voices?: WyomingVoice[] }> | undefined) ?? [];
        return tts.flatMap((t) => t.voices ?? []);
      }
      if (evt.type === 'error') {
        throw new Error(String(evt.data.message ?? 'Wyoming describe failed'));
      }
    }
  });
}

export async function synthesizeWyoming(
  urlOrHost: string,
  text: string,
  opts: {
    voice?: string;
    speaker?: string;
    language?: string;
    timeoutMs?: number;
  } = {},
): Promise<WyomingSynthResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const { host, port } = parseHostPort(urlOrHost);
  return await withSocket(host, port, timeoutMs, async (socket, reader) => {
    const data: Record<string, unknown> = { text };
    if (opts.voice || opts.speaker || opts.language) {
      const voice: Record<string, string> = {};
      if (opts.voice) voice.name = opts.voice;
      if (opts.speaker) voice.speaker = opts.speaker;
      if (opts.language) voice.language = opts.language;
      data.voice = voice;
    }
    sendEvent(socket, 'synthesize', data);

    const chunks: Buffer[] = [];
    let rate = 22050;
    let width = 2;
    let channels = 1;

    while (true) {
      const evt = await reader.next(timeoutMs);
      if (evt.type === 'audio-start') {
        rate = Number(evt.data.rate ?? rate);
        width = Number(evt.data.width ?? width);
        channels = Number(evt.data.channels ?? channels);
        continue;
      }
      if (evt.type === 'audio-chunk') {
        rate = Number(evt.data.rate ?? rate);
        width = Number(evt.data.width ?? width);
        channels = Number(evt.data.channels ?? channels);
        if (evt.payload?.length) chunks.push(evt.payload);
        continue;
      }
      if (evt.type === 'audio-stop') {
        const pcm = Buffer.concat(chunks);
        if (pcm.length === 0) throw new Error('Wyoming returned no audio');
        return {
          pcm,
          rate,
          width,
          channels,
          voice: opts.voice ?? 'piper-default',
        };
      }
      if (evt.type === 'error') {
        throw new Error(String(evt.data.message ?? JSON.stringify(evt.data)));
      }
    }
  });
}

export async function synthesizeWyomingToWav(
  urlOrHost: string,
  text: string,
  outWavPath: string,
  opts: {
    voice?: string;
    speaker?: string;
    language?: string;
    timeoutMs?: number;
  } = {},
): Promise<WyomingSynthResult> {
  const result = await synthesizeWyoming(urlOrHost, text, opts);
  fs.mkdirSync(path.dirname(outWavPath), { recursive: true });
  writeWav(outWavPath, result.pcm, result.rate, result.width, result.channels);
  return result;
}

async function withSocket<T>(
  host: string,
  port: number,
  timeoutMs: number,
  fn: (socket: net.Socket, reader: WyomingReader) => Promise<T>,
): Promise<T> {
  const socket = net.createConnection({ host, port });
  const reader = new WyomingReader();

  const result = await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Wyoming connection timed out after ${timeoutMs}ms (${host}:${port})`));
    }, timeoutMs + 5_000);

    socket.once('connect', () => {
      void fn(socket, reader).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
    socket.on('data', (d) => reader.push(d));
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      // ignore; callers finish on audio-stop
    });
  });

  socket.end();
  return result;
}
