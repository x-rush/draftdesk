#!/usr/bin/env bash
# 给三个 agent 镜像装上 Playwright / Chromium 并验证
#
# 用法（在能正常访问外网的终端里跑，比如开了代理的 PowerShell / Git Bash）：
#   cd C:/Users/77958/Projects/draftdesk/agents
#   bash docker/build-browsers.sh
#
# 单步执行也行，见 README.md 的「构建与更新」。

set -euo pipefail
cd "$(dirname "$0")/.."

REG="$(grep -E '^NPM_REGISTRY=' .env 2>/dev/null | cut -d= -f2-)"
echo "== 1/4 构建镜像"
echo "    npm 源: ${REG:-官方 registry.npmjs.org}"
# 逐个串行构建：docker compose build 一次跑三个时，任一失败会把另外两个
# 也 CANCEL 掉（实测白跑 7 分钟），所以这里分开跑并失败即停。
for svc in dsh openclaw hermes; do
  echo "--- $svc"
  if ! docker compose build "$svc"; then
    echo
    echo "构建失败：$svc"
    echo "已成功的服务会缓存下来，处理完（比如换 npm 源）重跑本脚本会直接跳过它们。"
    exit 1
  fi
done

echo
echo "== 2/4 用新镜像重启容器"
docker compose up -d

echo
echo "== 3/4 冒烟测试（起浏览器 → 渲染中文 → 截图）"
sleep 12
for c in agents-openclaw-1 agents-hermes-1 agents-dsh-1; do
  printf '%-20s ' "$c"
  docker exec "$c" sh -c 'NODE_PATH=/usr/local/lib/node_modules node /opt/browser-smoke.js' \
    || echo "失败（见上）"
done

echo
echo "== 4/4 token 上报守护检查"
sleep 8
# 上报配置（config.json / 账本）都在各自的数据卷里，重建容器不会丢，
# 守护挂在启动命令上，容器一起来就恢复，不需要重新接入。
check_report() {
  printf '%-20s ' "$1"
  docker exec "$1" sh -c "tail -1 '$2' 2>/dev/null" 2>/dev/null || true
  echo
}
check_report agents-openclaw-1 /home/node/.opentoken/daemon.log
check_report agents-hermes-1  /opt/data/.opentoken/daemon.log
check_report agents-dsh-1     /home/node/.opentoken/daemon.log
echo
echo "（出现 uploaded N usage / nothing new to upload 均为正常；空白表示还没跑到第一轮）"

echo
echo "完成。浏览器截图在各自容器的 /tmp/browser-smoke.png"

echo
echo "== 面板入口与登录凭据 =="
# 单独抽成脚本，平时想只看入口就跑：bash docker/dashboards.sh
bash docker/dashboards.sh || true
