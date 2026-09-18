# syntax=docker/dockerfile:1

# StemKit web: the desktop app's React UI and separation pipeline served from
# a container. Build: docker build -t stemkit .

# ---- web UI and server bundle ----
FROM node:22-bookworm-slim AS build
WORKDIR /src
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig*.json vite.web.config.mts ./
COPY scripts ./scripts
COPY build ./build
COPY src ./src
RUN npm run web:build

# ---- runtime ----
FROM python:3.11-slim-bookworm

# torch 2.8 with CUDA 12.8 runs on RTX 50 series (Blackwell) cards and older
# ones alike, and needs NVIDIA driver 570 or newer on the host
ARG TORCH_VERSION=2.8.0
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --upgrade pip wheel setuptools \
 && /opt/venv/bin/pip install "torch==${TORCH_VERSION}" "torchaudio==${TORCH_VERSION}" --index-url "${TORCH_INDEX_URL}"

COPY docker/requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt \
 && /opt/venv/bin/python -c "import torch, torchaudio, demucs, yt_dlp, packaging; assert torch.version.cuda, 'pip replaced the CUDA torch build'; print('torch', torch.__version__, 'cuda', torch.version.cuda)"

COPY --from=build /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY package.json ./
COPY python ./python
COPY --from=build /src/out ./out
RUN /opt/venv/bin/python -m compileall -q /app/python
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh

# stamped by the workflow so the app can show which build is running
ARG GIT_SHA=""
ENV STEMKIT_BUILD=${GIT_SHA} \
    STEMKIT_DATA=/config \
    STEMKIT_APP_DIR=/app \
    STEMKIT_PYTHON=/opt/venv/bin/python \
    STEMKIT_ATTENTION=efficient \
    YTDLP_AUTO_UPDATE=true \
    PORT=8080 \
    HOME=/config/home \
    XDG_CACHE_HOME=/config/cache \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility \
    PUID=99 \
    PGID=100 \
    UMASK=022

EXPOSE 8080
VOLUME /config

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
