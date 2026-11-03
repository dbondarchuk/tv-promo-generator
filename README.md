# ErsatzTV Promo Generator

Generate **30-second “next items” promos** for [ErsatzTV](https://ersatztv.org/) channels: animated triptych video, lower-third titles, optional multilingual voice-over, auto-regen before the current item ends, and one-click **Push** into ErsatzTV as pre-roll fillers.

```
┌────────────────────┬──────────┬──────────┐
│  Item 1 (50%)      │ Item 2   │ Item 3   │  0–10s   focus left
│  playing           │ freeze   │ freeze   │
└────────────────────┴──────────┴──────────┘
         ↘ smooth width transition ↙
┌──────────┬────────────────────┬──────────┐
│  Item 1  │  Item 2 (50%)      │ Item 3   │  10–20s  focus center
│  freeze  │  playing           │ freeze   │
└──────────┴────────────────────┴──────────┘
         ↘ smooth width transition ↙
┌──────────┬──────────┬────────────────────┐
│  Item 1  │  Item 2  │  Item 3 (50%)      │  20–30s  focus right
│  freeze  │  freeze  │  playing           │
└──────────┴──────────┴────────────────────┘
```

Each promo is written as `{output}/{channel}/next-items.mp4`.

---

## Features

| Area | What you get |
|---|---|
| **Video** | Single 30s encode: three upcoming primary items, animated 50/25/25 → 25/50/25 → 25/25/50 layout |
| **Graphics** | Channel logo, logo-derived color bar, localized “Next / After that” headlines + start time |
| **Voice** | Piper (Wyoming) preferred; Edge TTS then Windows SAPI fallbacks; pause between cue and title |
| **Automation** | Scheduler regenerates when the current item is within `REGEN_LEAD_MINUTES` of ending |
| **Push** | Creates an Other Video library, filler presets, wires classic schedules as count-1 pre-rolls |

---

## Requirements

- **Node.js 20+**
- **ffmpeg / ffprobe** (auto-fetched via `npm run setup:ffmpeg`, or set `FFMPEG_PATH` / `FFPROBE_PATH`)
- Access to ErsatzTV:
  - HTTP API (`ETV_URL` + API key)
  - `ersatztv.sqlite3` (for playout / media paths)
  - Readable media files (via path rewrite — see below)
- Optional: **Wyoming Piper** TCP service for local TTS (e.g. Home Assistant add-on on port `10200`)

---

## Quick start (dev)

```bash
npm install
cp .env.example .env          # edit paths / ErsatzTV / Piper
npm run setup:ffmpeg          # system ffmpeg, else download into tools/ffmpeg
npm run build -w @promo/shared
npm run dev
```

| Service | URL |
|---|---|
| UI | http://localhost:5173 |
| API | http://localhost:5174 |

Open **Settings**, fill ErsatzTV + paths, save. On **Channels**, enable channels and click **Generate** (or **Generate all**). Preview plays in the UI when ready.

---

## Path rewrite (critical)

ErsatzTV often stores Linux-style paths in SQLite while this app runs on Windows (or a different mount).

| Variable | Role |
|---|---|
| `ETV_PATH_PREFIX` | Prefix as stored in the DB (e.g. `/media/videos`) |
| `LIBRARY_PATH` | Where *this* process can read the same files (e.g. `Y:\videos`) |

Example: DB has `/media/videos/shows/Foo/…` → app opens `Y:\videos\shows\Foo\…`.

`OUTPUT_PATH` is where promos are written. `ETV_LIBRARY_PATH` must point at the **same folder as ErsatzTV sees it** (different mount/path is fine) so Push can register files.

---

## Using the UI

1. **Settings** — ErsatzTV URL, API key, database, library/output paths, encoder, resolution.
2. **Channels** — list from ErsatzTV; toggle **enabled**, optional per-channel language override.
3. **Generate** — builds `next-items.mp4` for one channel; job log streams over SSE.
4. **Generate all** — queues every enabled channel.
5. **Push to ErsatzTV** — library + fillers + schedule wiring (classic playouts only).

Per-channel language drives overlays and VO (e.g. `uk` → Ukrainian templates / Piper `uk_UA-*` voice).

---

## Promo layout & audio

- **30 seconds**, three phases (~10s each) with **1.5s** smooth width transitions.
- Focused panel is **50%**; the other two stay **25%** (first frame before they play, last frame after).
- Lower-third follows the focused panel: `Next: {title}` / `After that: {title}`, episode line, start time.
- Movie years like `(2021)` are stripped from display and speech.
- Source audio is **muted**; only VO (or silence) is used.

### Voice-over

Cue → short pause (`VOICE_PAUSE_MS`, default 450) → title (+ season/episode when known):

| Cue | Spoken pattern |
|---|---|
| First item | `Next on {channel}.` → pause → `{title}. Season …` |
| 2nd / 3rd | `After that.` → pause → `{title}. Season …` |

Engine order:

1. **Piper** via Wyoming TCP (`PIPER_URL`)
2. **Edge TTS** (cloud; may fail offline / 403)
3. **Windows SAPI** (win32 only)

Per-language voices: `PIPER_VOICE_UK`, `PIPER_VOICE_EN`, … or auto-pick from Piper’s `describe`. Optional global `PIPER_VOICE`.

---

## Auto regeneration

A background scheduler (default every 60s) checks enabled channels. When the current primary item ends within `REGEN_LEAD_MINUTES`, it enqueues a new promo so the next block is ready.

---

## Push to ErsatzTV

The **Push** button:

1. Creates/updates local Other Video library **Promo Generator** (folder = `ETV_LIBRARY_PATH`)
2. Scans the library
3. Upserts filler preset `Promo pre-roll {channel number}` (count **1**)
4. Sets that preset as `PreRollFillerId` on classic schedule items
5. Resets the channel playout

Skipped (with reason) when the playout is not classic, or the schedule is shared by multiple channels.

> Push writes to `ersatztv.sqlite3` and resets playouts — confirm before running in production.

---

## Docker

### Build locally

```bash
docker compose up -d --build
```

Mount the **same** promo host folder into this container and into ErsatzTV (`OUTPUT_PATH` / `ETV_LIBRARY_PATH`). See `docker-compose.yml` for media, config, cache, and DB mounts.

Hardware:

- **VAAPI / QSV** — uncomment `/dev/dri` (and set `HARDWARE_ACCELERATION`)
- **NVENC** — uncomment the NVIDIA device reservation

The image installs Debian `ffmpeg` (VAAPI-ready with the bundled drivers). UI + API are served together on port **5174**.

### Published image (GHCR)

On pushes to `main` / `master` and on tags `v*`, GitHub Actions builds and publishes to GitHub Container Registry:

```text
ghcr.io/<owner>/<repo>:latest
ghcr.io/<owner>/<repo>:sha-<commit>
ghcr.io/<owner>/<repo>:1.0.0          # from git tag v1.0.0
```

Pull / run (after the package is public, or after `docker login ghcr.io`):

```bash
docker pull ghcr.io/<owner>/tv-promo-generator:latest
docker compose up -d   # or set image: in compose instead of build:
```

To use the published image instead of building locally, set in `docker-compose.yml`:

```yaml
image: ghcr.io/<owner>/tv-promo-generator:latest
# build: .   # comment out when pulling
```

First-time GHCR notes:

1. Push this repo to GitHub and ensure Actions are enabled.
2. After the first successful workflow, open **Packages** on the repo and set the package visibility (public or grant access).
3. For private packages: `echo $GITHUB_TOKEN | docker login ghcr.io -u USERNAME --password-stdin`

---

## Configuration

Copy [`.env.example`](.env.example) → `.env`. Env vars override `config/settings.json`.

### ErsatzTV & paths

| Variable | Description |
|---|---|
| `ETV_URL` | ErsatzTV base URL |
| `ETV_API_KEY` | From `api-secrets.json` (`X-Etv-Api-Key`) |
| `ETV_DATABASE` | Path to `ersatztv.sqlite3` |
| `LIBRARY_PATH` | Local media root |
| `ETV_PATH_PREFIX` | DB path prefix rewritten to `LIBRARY_PATH` |
| `OUTPUT_PATH` | Where `{channel}/next-items.mp4` is written |
| `ETV_LIBRARY_PATH` | Same promo folder as ErsatzTV sees it |
| `CACHE_PATH` | Voice / work cache |
| `CONFIG_PATH` | `settings.json` + channel overrides |
| `PORT` | API port (default `5174`) |
| `LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` |

### Encoding

| Variable | Description |
|---|---|
| `HARDWARE_ACCELERATION` | `None` \| `Nvenc` \| `Qsv` \| `Vaapi` \| `Amf` \| `VideoToolbox` |
| `VIDEO_CODEC` | `H264` or `Hevc` |
| `VIDEO_BITRATE` / `AUDIO_BITRATE` | kbps |
| `RESOLUTION` | e.g. `1920x1080` |
| `VIDEO_PRESET` / `VIDEO_PROFILE` | Encoder preset / profile |
| `VAAPI_DEVICE` / `VAAPI_DRIVER` | VAAPI only |
| `FFMPEG_PATH` / `FFPROBE_PATH` | Optional absolute binaries |

### Voice & regen

| Variable | Description |
|---|---|
| `VOICE_ENABLED` | `true` / `false` |
| `PIPER_URL` | Wyoming Piper, e.g. `http://192.168.0.151:10200` |
| `PIPER_VOICE_EN` / `PIPER_VOICE_UK` / `PIPER_VOICE_<LANG>` | Per-language Piper voice |
| `PIPER_VOICE` / `PIPER_SPEAKER` | Default voice / speaker |
| `VOICE_PAUSE_MS` | Silence between cue and title (default `450`) |
| `TTS_TIMEOUT_MS` | Per synthesis attempt timeout |
| `REGEN_LEAD_MINUTES` | Auto-regen lead time |

---

## Project layout

```
client/          React UI (Vite)
server/          Express API, jobs, ffmpeg, TTS, ErsatzTV integration
packages/shared/ Shared types & settings helpers
config/          Runtime settings + channel overrides
output/          Generated promos
cache/           Voice cache + encode work dirs
tools/ffmpeg/    Optional vendored binaries from setup:ffmpeg
```

Useful scripts:

```bash
npm run dev          # API + UI
npm run build        # shared → server → client
npm start            # production server (after build)
npm test             # server tests
npm run typecheck
npm run setup:ffmpeg
```

Force a fresh ffmpeg download: `FORCE_FFMPEG_DOWNLOAD=1 npm run setup:ffmpeg`.

---

## Troubleshooting

| Symptom | Likely fix |
|---|---|
| `File not found` while generating | Check `ETV_PATH_PREFIX` ↔ `LIBRARY_PATH` rewrite; confirm files exist under `LIBRARY_PATH` |
| Black gap in the focused panel | Needs current build (`scale=eval=frame`); restart `npm run dev` after pull |
| VO hangs / Edge 403 | Set `PIPER_URL` to a reachable Wyoming Piper; Edge is optional fallback |
| Push skipped | Classic playout only; shared schedules across channels are skipped |
| Apostrophe breaks ffmpeg drawtext | Fixed via double-escaped `'` in filter graphs — pull latest |
| Empty / wrong titles (`Item #123`) | DB metadata / XMLTV; ensure `ETV_DATABASE` is readable |

Job logs in the Channels UI show each encode step (VO, windows, ffmpeg). Failed encodes also leave `filter_complex.txt` under the job work dir in `cache/`.
