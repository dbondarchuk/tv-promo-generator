FROM jellyfin/jellyfin:latest AS jf

FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm install
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
    PATH="/usr/lib/jellyfin-ffmpeg:${PATH}"

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-noto-core \
      intel-media-va-driver-non-free \
      mesa-va-drivers \
      vainfo \
      libva2 \
      libva-drm2 \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

COPY --from=jf /usr/lib/jellyfin-ffmpeg /usr/lib/jellyfin-ffmpeg
RUN ln -sf /usr/lib/jellyfin-ffmpeg/ffmpeg /usr/local/bin/ffmpeg \
 && ln -sf /usr/lib/jellyfin-ffmpeg/ffprobe /usr/local/bin/ffprobe

WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm install --omit=dev

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
