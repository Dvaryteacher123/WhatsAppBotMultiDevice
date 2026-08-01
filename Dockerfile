FROM oven/bun:1-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    build-essential \
    libcairo2-dev \
    libpango1.0-dev \
    libjpeg-dev \
    libgif-dev \
    librsvg2-dev \
    ffmpeg \
    webp \
    git \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Bust the Docker cache whenever a new yt-dlp release ships. Without this, the RUN
# layer below stays cached across rebuilds and yt-dlp freezes at its first-built
# version — which modern YouTube rejects ("Requested format is not available").
ADD https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest /tmp/yt-dlp-latest.json
RUN wget -q https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -O /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

ENV YTDLP_PATH=/usr/local/bin/yt-dlp
ENV FFMPEG_PATH=ffmpeg

WORKDIR /app

# Copy manifests for all workspace members before install (better layer caching)
COPY package.json bun.lock* ./
COPY dashboard/package.json ./dashboard/
RUN bun install --frozen-lockfile

# Copy full source and build dashboard
COPY . .
RUN bun run --cwd dashboard build

RUN mkdir -p temp

ENV NODE_ENV=production

EXPOSE 8080

# Self-update yt-dlp on every boot so a long-lived container stays current even
# without an image rebuild. Non-fatal if the network is unavailable at startup.
CMD ["bun", "--smol", "index.js"]
