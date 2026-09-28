#!/bin/sh
# opentoken（生财 token 上报）守护进程 —— 供 Docker 容器使用。
#
# 容器里没有 systemd/launchd，所以 `opentoken service install` 必然失败。
# 正解是把守护循环挂到容器的启动命令上（见 compose.yaml 的 command:）。
#
# 约定：
#   $HOME 决定两件事 —— 扫描哪个 agent 的用量数据、账本落在哪里。
#     openclaw : /home/node      （数据卷里已有 .openclaw/）
#     hermes   : /opt/data       （hermes 用户的家目录，数据卷根）
#     dsh      : /home/node      （已固化在镜像 entrypoint 中，不走本脚本）
#   TOKENRANK_WEBHOOK   个人上报链接，首次运行自动 connect
#   TOKENRANK_INTERVAL  上报周期（秒，默认 1800）
#
# 所有状态（config.json / device_id / state.json / 日志）都落在 $HOME/.opentoken，
# 即各 agent 自己的数据卷里，容器重建不会丢。

OT=/opt/opentoken/opentoken
OT_HOME="$HOME/.opentoken"

if [ ! -x "$OT" ]; then
  echo "[opentoken] 二进制缺失: $OT，跳过上报"
  exit 0
fi

if ! mkdir -p "$OT_HOME" 2>/dev/null; then
  echo "[opentoken] 无法创建 $OT_HOME（权限不足？），跳过上报"
  exit 0
fi

# 首次接入：保存个人上报链接。已接入则跳过（幂等）。
if [ -n "${TOKENRANK_WEBHOOK:-}" ] && [ ! -f "$OT_HOME/config.json" ]; then
  echo "[opentoken] 首次接入 $(date -u +%FT%TZ)"
  "$OT" connect "$TOKENRANK_WEBHOOK" >>"$OT_HOME/connect.log" 2>&1
fi

# 固定设备身份：device_id 缺失时用 .env 里钉好的值补回去。
# 不钉住的话，容器重建（或账本被清）会生成全新 device_id，
# tokenrank 的「设备管理」列表就每次重建多一台 Linux 设备。
if [ -n "${OPENTOKEN_DEVICE_ID:-}" ] && [ ! -f "$OT_HOME/device_id" ]; then
  printf '%s' "$OPENTOKEN_DEVICE_ID" > "$OT_HOME/device_id" 2>/dev/null \
    && echo "[opentoken] 已固定 device_id=${OPENTOKEN_DEVICE_ID}"
fi

echo "[opentoken] 守护启动 HOME=$HOME 周期=${TOKENRANK_INTERVAL:-1800}s"

# daemon --once = 扫一遍 + 上传一次就退出；外层循环负责周期性唤醒。
while true; do
  "$OT" daemon --once >>"$OT_HOME/daemon.log" 2>&1
  sleep "${TOKENRANK_INTERVAL:-1800}"
done
