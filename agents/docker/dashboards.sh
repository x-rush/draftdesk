#!/usr/bin/env bash
# 打印三个 agent 的 Dashboard 入口 + 登录凭据（不用再去翻 .env / 容器日志）
#
# 用法：
#   bash docker/dashboards.sh            # 只打印
#   bash docker/dashboards.sh --open     # 打印并用默认浏览器打开三个面板
#
# 凭据来源（都是本机文件/容器日志，不联网）：
#   openclaw : 容器内 `openclaw dashboard --json` 实时取（token 已内嵌在 URL 里）
#   hermes   : agents/.env 的 HERMES_DASHBOARD_BASIC_AUTH_USERNAME / _PASSWORD
#   dsh      : 容器启动日志里打印的一次性 token（重启会变，每次现取）

cd "$(dirname "$0")/.."
OPEN=0
[ "${1:-}" = "--open" ] && OPEN=1

# --- 从 .env 取值（同一 key 出现多次时取最后一次，与 compose env_file 一致）---
envget() {
  local v
  v="$(grep -E "^${1}=" .env 2>/dev/null | tail -1 | cut -d= -f2-)"
  printf '%s' "${v:-$2}"
}

OC_PORT="$(envget OPENCLAW_PORT 18789)"
HM_UI_PORT="$(envget HERMES_DASHBOARD_PORT 9119)"
HM_API_PORT="$(envget HERMES_GATEWAY_PORT 8642)"
HM_USER="$(envget HERMES_DASHBOARD_BASIC_AUTH_USERNAME '')"
HM_PASS="$(envget HERMES_DASHBOARD_BASIC_AUTH_PASSWORD '')"
HM_KEY="$(envget API_SERVER_KEY '')"
DSH_PORT="$(grep -E '^DSH_PORT=' ../../dsh/.env 2>/dev/null | tail -1 | cut -d= -f2-)"
DSH_PORT="${DSH_PORT:-3080}"

# HTTP 探测：只取状态码，超时 5s，失败显示 --
probe() { curl -s -o /dev/null -m 5 -w '%{http_code}' "$1" 2>/dev/null || echo "--"; }

hr() { printf '%s\n' "------------------------------------------------------------"; }

echo
echo "== Dashboard 入口 =="
hr

# ---------- openclaw ----------
# 面板 token 由 gateway 现签，直接问容器要最准；拿不到就退回 .env 里的静态 token。
OC_URL="$(docker exec -u 1000:1000 agents-openclaw-1 \
  node openclaw.mjs dashboard --no-open --json 2>/dev/null \
  | grep -oE '"url":"[^"]+"' | head -1 | cut -d'"' -f4)"
OC_FALLBACK_TOKEN="$(envget OPENCLAW_GATEWAY_TOKEN '')"
[ -z "$OC_URL" ] && [ -n "$OC_FALLBACK_TOKEN" ] && \
  OC_URL="http://127.0.0.1:${OC_PORT}/#token=${OC_FALLBACK_TOKEN}"
[ -z "$OC_URL" ] && OC_URL="http://127.0.0.1:${OC_PORT}/（取 token 失败：容器没起来？）"

printf 'openclaw   [%s]  %s\n' "$(probe "http://127.0.0.1:${OC_PORT}/")" "$OC_URL"
echo "           Control UI；URL 里已带 #token，点开即用，不用再填任何东西。"

# ---------- hermes ----------
echo
hr
printf 'hermes     [%s]  http://127.0.0.1:%s/\n' "$(probe "http://127.0.0.1:${HM_UI_PORT}/")" "$HM_UI_PORT"
if [ -n "$HM_USER" ]; then
  echo "           登录页会跳转 /login（Username & Password 方式）："
  echo "             账号 : $HM_USER"
  echo "             密码 : $HM_PASS"
  # 实测一次登录接口，确认这组凭据真的能用（接口变了只会显示「未通过」，不影响上面输出）
  LOGIN="$(curl -s -m 8 -X POST "http://127.0.0.1:${HM_UI_PORT}/auth/password-login" \
    -H 'Content-Type: application/json' \
    -d "{\"provider\":\"basic\",\"username\":\"${HM_USER}\",\"password\":\"${HM_PASS}\"}" 2>/dev/null)"
  case "$LOGIN" in
    *'"ok":true'*) echo "             校验 : ✓ 已用这组账号密码登录成功" ;;
    *)             echo "             校验 : ✗ 登录未通过（$LOGIN）" ;;
  esac
else
  echo "           未配置 basic auth（.env 里没有 HERMES_DASHBOARD_BASIC_AUTH_USERNAME）。"
  echo "           非 loopback 绑定时 gateway 会「无鉴权即拒绝启动」，需要补上："
  echo "             HERMES_DASHBOARD_BASIC_AUTH_USERNAME / _PASSWORD / _SECRET"
fi
if [ -n "$HM_KEY" ]; then
  echo "           OpenAI 兼容 API: http://127.0.0.1:${HM_API_PORT}/v1"
  echo "             Authorization: Bearer $HM_KEY"
fi

# ---------- dsh ----------
echo
hr
# dsh 每次启动在日志里打印一次带 token 的 URL；重启就换，所以取最后一条。
DSH_TOKEN="$(docker logs agents-dsh-1 2>&1 | grep -oE 'token=[A-Za-z0-9_-]+' | tail -1)"
if [ -n "$DSH_TOKEN" ]; then
  printf 'dsh        [%s]  http://127.0.0.1:%s/?%s\n' \
    "$(probe "http://127.0.0.1:${DSH_PORT}/?${DSH_TOKEN}")" "$DSH_PORT" "$DSH_TOKEN"
  echo "           token 每次重启都会重新生成——上面这条是容器最新一次启动打印的。"
  echo "           失效了就重看日志：docker logs agents-dsh-1 | grep token="
else
  printf 'dsh        [%s]  http://127.0.0.1:%s/（没取到 token）\n' \
    "$(probe "http://127.0.0.1:${DSH_PORT}/")" "$DSH_PORT"
  echo "           取 token：docker logs agents-dsh-1 | grep 'dsh web'"
fi

echo
hr
echo "状态码说明：200/302/401 都表示服务活着（302=跳登录页，401=缺 token）；-- 表示连不上。"
echo "看 token 消耗排行：https://scys.com/tokenrank —— openclaw/hermes 要切到「工具榜」，"
echo "总榜单位是「亿」，这两个的百万级用量会被淹没。"

if [ "$OPEN" = "1" ]; then
  echo
  echo "== 打开浏览器 =="
  for u in "$OC_URL" "http://127.0.0.1:${HM_UI_PORT}/" "http://127.0.0.1:${DSH_PORT}/?${DSH_TOKEN}"; do
    [ -z "$u" ] && continue
    if command -v explorer.exe >/dev/null 2>&1; then explorer.exe "$u" >/dev/null 2>&1
    elif command -v open >/dev/null 2>&1; then open "$u"
    elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$u"
    else echo "  （找不到浏览器命令）$u"; fi
    echo "  → $u"
  done
fi
