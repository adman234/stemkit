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

# GPU=cuda (the default): torch 2.8 with CUDA 12.8 runs on RTX 50 series
# (Blackwell) cards and older ones alike, and needs NVIDIA driver 570 or newer
# on the host.
# GPU=rocm: torch 2.8 with ROCm 6.4 for AMD cards on a Linux host, RDNA4
# (RX 9070) included. Experimental, as it is upstream
ARG GPU=cuda
ARG TORCH_VERSION=2.8.0
# overrides the index GPU picks
ARG TORCH_INDEX_URL=""

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tini ca-certificates libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

RUN case "$GPU" in \
      cuda) index="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/cu128}" ;; \
      rocm) index="${TORCH_INDEX_URL:-https://download.pytorch.org/whl/rocm6.4}" ;; \
      *) echo "GPU must be cuda or rocm, not $GPU" >&2; exit 1 ;; \
    esac \
 && python -m venv /opt/venv \
 && /opt/venv/bin/pip install --upgrade pip wheel setuptools \
 && /opt/venv/bin/pip install "torch==${TORCH_VERSION}" "torchaudio==${TORCH_VERSION}" --index-url "$index"

COPY docker/requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install -r /tmp/requirements.txt \
 && rm /tmp/requirements.txt \
 && GPU="$GPU" /opt/venv/bin/python -c "import os, torch, torchaudio, demucs, yt_dlp, packaging; gpu = os.environ['GPU']; build = torch.version.hip if gpu == 'rocm' else torch.version.cuda; assert build, 'pip replaced the ' + gpu + ' torch build'; print('torch', torch.__version__, gpu, build)"

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
