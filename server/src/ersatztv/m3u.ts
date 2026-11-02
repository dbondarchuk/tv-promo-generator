export interface M3uChannel {
  number: string;
  name: string;
  tvgId: string;
  logoUrl?: string;
  group?: string;
}

export function parseM3u(content: string): M3uChannel[] {
  const lines = content.split(/\r?\n/);
  const channels: M3uChannel[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.trim() ?? '';
    if (!line.startsWith('#EXTINF:')) continue;
    const attrs = parseExtInfAttrs(line);
    const name = line.includes(',') ? line.slice(line.lastIndexOf(',') + 1).trim() : (attrs['tvg-name'] ?? '');
    const number = attrs['tvg-chno'] ?? attrs['channel-number'] ?? attrs['tvg-name'] ?? String(channels.length + 1);
    channels.push({
      number: String(number),
      name: name || `Channel ${number}`,
      tvgId: attrs['tvg-id'] ?? String(number),
      logoUrl: attrs['tvg-logo'],
      group: attrs['group-title'],
    });
  }
  return channels;
}

function parseExtInfAttrs(line: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z0-9-]+)="([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(line)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}
