# hermes-agent + Playwright / Chromium
#
# 同 openclaw.Dockerfile：浏览器系统依赖必须进镜像层，容器可写层是临时的。
# hermes 自带 browser 能力（config.yaml 的 browser 段 / browser_connect.py，走 CDP
# 9222），装上 chromium 后它就能在本地起浏览器，不用再连宿主的 Chrome。
#
# 基础镜像 digest 由 compose 从 .env 的 HERMES_IMAGE 传入。
# Build: docker build --build-arg BASE_IMAGE=<image>@sha256:... -t hermes-pw .

ARG BASE_IMAGE=nousresearch/hermes-agent:latest
FROM ${BASE_IMAGE}

ARG PLAYWRIGHT_VERSION=1.63.0

ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
# Chromium 下载源，默认官方 CDN；断流时可传 build-arg 换国内镜像
ARG PLAYWRIGHT_DOWNLOAD_HOST="https://cdn.playwright.dev"
ENV PLAYWRIGHT_DOWNLOAD_HOST=${PLAYWRIGHT_DOWNLOAD_HOST}

# hermes 镜像默认以 root 启动（s6 内部再降到 hermes 用户），安装阶段保持 root
USER root

# 走官方源直连。如果你的网络连不上 deb.debian.org，把下面这段注释放开换成镜像源：
#   RUN set -eu; for f in /etc/apt/sources.list /etc/apt/sources.list.d/*; do \
#         [ -f "$f" ] || continue; \
#         sed -i 's|deb\.debian\.org|mirrors.tuna.tsinghua.edu.cn|g; \
#                 s|security\.debian\.org/debian-security|mirrors.tuna.tsinghua.edu.cn/debian-security|g' "$f"; \
#       done

# npm 抗抖：ECONNRESET 靠重试解决，不是靠等。可传 build-arg 换镜像：
#   NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=""
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && { [ -n "${NPM_REGISTRY}" ] && npm config set registry "${NPM_REGISTRY}" || true; }

# 主安装：只装必需项。中文字体单独一条（见下）—— 字体包较大，下载失败不能拖垮整个构建。
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get install -y --no-install-recommends -o Acquire::Retries=3 ca-certificates \
 && npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
 && playwright install-deps chromium \
 && playwright install chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm/_cacache /tmp/*

# 中文字体：失败也放行，浏览器本身仍可用
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
      fonts-liberation fonts-wqy-microhei || true

COPY browser-smoke.js /opt/browser-smoke.js

# 注意：不要在这里 USER hermes —— hermes 的 s6 entrypoint 需要 root 来降权。
