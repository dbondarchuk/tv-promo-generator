FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY client/package.json client/
# Windows lockfiles omit Linux optional natives (npm optional-deps bug).
RUN npm install \
 && npm install --no-save @rollup/rollup-linux-x64-gnu
COPY . .
RUN npm run build

FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    PORT=5174 \
    CONFIG_PATH=/data/config \
    OUTPUT_PATH=/data/output \
    CACHE_PATH=/data/cache \
    LIBRARY_PATH=/library \
    ETV_LIBRARY_PATH=/promos \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    FFPROBE_PATH=/usr/bin/ffprobe

# VA drivers: mesa is in main; Intel iHD needs non-free / non-free-firmware.
RUN set -eux; \
    . /etc/os-release; \
    printf 'deb http://deb.debian.org/debian %s main contrib non-free non-free-firmware\n' "$VERSION_CODENAME" \
      > /etc/apt/sources.list.d/debian-extra.list; \
    printf 'deb http://deb.debian.org/debian-security %s-security main contrib non-free non-free-firmware\n' "$VERSION_CODENAME" \
      >> /etc/apt/sources.list.d/debian-extra.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      ffmpeg \
      fonts-noto-core \
      fonts-dejavu-core \
      mesa-va-drivers \
      vainfo \
      libva2 \
      libva-drm2 \
      python3 \
      make \
      g++; \
    apt-get install -y --no-install-recommends intel-media-va-driver-non-free \
      || echo "intel-media-va-driver-non-free unavailable; continuing with mesa-va-drivers"; \
    rm -rf /var/lib/apt/lists/*; \
    ffmpeg -version >/dev/null; \
    ffprobe -version >/dev/null

WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY client/package.json client/
# Windows lockfiles omit Linux optional natives (same npm optional-deps bug as rollup).
RUN npm install --omit=dev \
 && npm install --no-save --os=linux --cpu=x64 sharp

COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/shared/package.json packages/shared/package.json
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/package.json server/package.json
COPY --from=build /app/client/dist client/dist
COPY assets assets

RUN mkdir -p /data/config /data/output /data/cache /library /promos /app/assets/fonts \
 && if [ -f /usr/share/fonts/truetype/noto/NotoSans-Regular.ttf ]; then \
      cp /usr/share/fonts/truetype/noto/NotoSans-Regular.ttf /app/assets/fonts/NotoSans-Regular.ttf; \
    elif [ -f /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf ]; then \
      cp /usr/share/fonts/truetype/dejavu/DejaVuSans.ttf /app/assets/fonts/NotoSans-Regular.ttf; \
    fi

EXPOSE 5174
CMD ["node", "server/dist/index.js"]
