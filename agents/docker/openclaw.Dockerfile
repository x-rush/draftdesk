# openclaw + Playwright / Chromium
#
# 为什么必须自建镜像：容器没有 systemd，可写层又是临时的，任何"让 agent 现场装
# playwright"的做法都会在容器重建后消失。而且 playwright 的浏览器需要一批系统级
# .so 依赖（libnss3 / libgbm / libasound 等），共享卷装不了系统库 —— 只能进镜像层。
#
# 基础镜像 digest 由 compose 从 .env 的 OPENCLAW_IMAGE 传入。
# 更新基础镜像：改 .env 的 digest，然后 `docker compose build openclaw`（或 bash update.sh）。
#
# Build: docker build --build-arg BASE_IMAGE=<image>@sha256:... -t openclaw-pw .

ARG BASE_IMAGE=ghcr.io/openclaw/openclaw:latest
FROM ${BASE_IMAGE}

ARG PLAYWRIGHT_VERSION=1.63.0

# 浏览器二进制装到固定路径（镜像层内，重建不丢）
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers
# Chromium 下载源。默认官方 CDN；断流时可传 build-arg 换国内镜像：
#   PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
ARG PLAYWRIGHT_DOWNLOAD_HOST="https://cdn.playwright.dev"
ENV PLAYWRIGHT_DOWNLOAD_HOST=${PLAYWRIGHT_DOWNLOAD_HOST}

USER root

# 走官方源直连。如果你的网络连不上 deb.debian.org，把下面这段注释放开换成镜像源：
#   RUN set -eu; for f in /etc/apt/sources.list /etc/apt/sources.list.d/*; do \
#         [ -f "$f" ] || continue; \
#         sed -i 's|deb\.debian\.org|mirrors.tuna.tsinghua.edu.cn|g; \
#                 s|security\.debian\.org/debian-security|mirrors.tuna.tsinghua.edu.cn/debian-security|g' "$f"; \
#       done
# （注意要用 for 逐文件处理：直接给 sed 传多个路径时，只要有一个不存在它就整体失败。）

# npm 抗抖：ECONNRESET 靠重试解决，不是靠等。可传 build-arg 换镜像：
#   NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=""
RUN npm config set fetch-retries 5 \
 && npm config set fetch-retry-mintimeout 20000 \
 && npm config set fetch-retry-maxtimeout 120000 \
 && npm config set fetch-timeout 600000 \
 && { [ -n "${NPM_REGISTRY}" ] && npm config set registry "${NPM_REGISTRY}" || true; }

# 主安装。中文字体单独一条（见下）—— 字体包较大，下载失败不能拖垮整个构建。
# Acquire::Retries 让偶发网络抖动自动重试。
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get install -y --no-install-recommends -o Acquire::Retries=3 ca-certificates \
 && npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
 && playwright install-deps chromium \
 && playwright install chromium \
 && rm -rf /var/lib/apt/lists/* /root/.npm/_cacache /tmp/*

# 中文字体：截图/渲染中文页面不出方块。失败也放行（浏览器本身仍可用）。
RUN apt-get -o Acquire::Retries=3 update \
 && apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
      fonts-liberation fonts-wqy-microhei || true

COPY browser-smoke.js /opt/browser-smoke.js

# 回到镜像原本的运行用户（openclaw 以 node 运行）
USER node
