#!/usr/bin/env bash
# 一键更新 agents 组三个 agent
#   openclaw / hermes : 官方镜像按 sha256 digest 固定 → 自动拉最新、重写 .env、重建自建镜像
#   dsh               : 本地构建 → 自动查 npm 最新非 alpha 版本、重写 ../../dsh/.env 的 DSH_VERSION
#
# 用法：
#   bash update.sh                 # 三个都更新（推荐）
#   bash update.sh --check         # 只看有没有新版，不改动任何文件
#   bash update.sh openclaw        # 只更新指定服务（openclaw / hermes / dsh）
#   bash update.sh --stable        # dsh 用 npm 的 latest 标签而不是最新 rc（更保守）
#
# 回滚：脚本会备份 .env → .env.bak-<时间戳>、../../dsh/.env → dsh.env.bak-<时间戳>。
#       把旧值抄回去再 `docker compose up -d <服务>` 即可（旧镜像还在磁盘上）。
#
# 注意：openclaw / hermes 重建要走外网（npm + Playwright CDN），而容器用不上宿主
#       127.0.0.1 的代理。卡在拉包就 Ctrl+C，把命令贴到开了 VPN 的外部终端重跑，
#       已成功的会走构建缓存。

set -uo pipefail
cd "$(dirname "$0")"

ENV_FILE=.env
DSH_ENV=../../dsh/.env
STAMP="$(date +%Y%m%d-%H%M%S)"

CHECK=0
STABLE=0
TARGETS=()
for a in "$@"; do
  case "$a" in
    --check)  CHECK=1 ;;
    --stable) STABLE=1 ;;
    openclaw|hermes|dsh) TARGETS+=("$a") ;;
    *) echo "未知参数：$a（可用：openclaw / hermes / dsh / --check / --stable）"; exit 1 ;;
  esac
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(openclaw hermes dsh)

want() { printf '%s\n' "${TARGETS[@]}" | grep -qx "$1"; }

declare -A REF=( [openclaw]="ghcr.io/openclaw/openclaw:latest"
                 [hermes]="nousresearch/hermes-agent:latest" )
declare -A VAR=( [openclaw]="OPENCLAW_IMAGE"
                 [hermes]="HERMES_IMAGE" )

TO_BUILD=()   # 需要重建的服务
FAILED=()

# 取仓库最新 digest。优先用 imagetools 只查 manifest（几 KB，不下载镜像层）；
# 失败（registry 连不上、没装 buildx）再退回真的 docker pull。
# --check 模式不退回 pull（那会把整镜像拖下来，check 就没意义了）。
# pull 套 timeout，避免 registry 半死不活时无限挂着（返回裸 sha256:...）。
latest_digest() { # $1=ref
  local ref="$1" d=""
  d="$(docker buildx imagetools inspect "$ref" 2>/dev/null | awk '/^Digest:/{print $2; exit}')"
  if [ -z "$d" ] && [ "$CHECK" != "1" ]; then
    if command -v timeout >/dev/null 2>&1; then
      timeout 900 docker pull "$ref" >/dev/null 2>&1
    else
      docker pull "$ref" >/dev/null 2>&1
    fi
    d="$(docker inspect --format '{{index .RepoDigests 0}}' "$ref" 2>/dev/null | sed 's|.*@||')"
  fi
  printf '%s' "$d"
}

# ---------- openclaw / hermes：官方镜像 digest ----------
pin_latest() { # $1=服务名
  local svc="$1" var="${VAR[$1]}" ref="${REF[$1]}" repo="${REF[$1]%:*}"
  echo "── $svc"
  local digest old
  digest="$(latest_digest "$ref")"
  if [ -z "$digest" ]; then
    echo "   取不到最新 digest（registry 连不上？）。手动重试：docker pull $ref"
    FAILED+=("$svc"); return
  fi
  old="$(grep -E "^${var}=" "$ENV_FILE" 2>/dev/null | cut -d= -f2- | sed 's|.*@||' || true)"
  if [ "$old" = "$digest" ]; then
    echo "   已是最新（digest 未变）"; return
  fi
  echo "   旧 ${old:-<未设置>}"
  echo "   新 $digest"
  [ "$CHECK" = "1" ] && { echo "   [check] 不改动文件"; return; }
  [ ! -f "$ENV_FILE.bak-$STAMP" ] && cp "$ENV_FILE" "$ENV_FILE.bak-$STAMP" \
    && echo "   已备份 .env -> .env.bak-$STAMP"
  sed -i "s|^${var}=.*|${var}=${repo}@${digest}|" "$ENV_FILE"
  TO_BUILD+=("$svc")
}

# ---------- dsh：npm 版本 ----------
dsh_target_version() {
  if [ "$STABLE" = "1" ]; then
    npm view @deepseek-ai/dsh dist-tags --json 2>/dev/null \
      | grep -o '"latest"[^,]*' | grep -oE '[0-9]+\.[0-9A-Za-z.\-]*' | head -1
  else
    # 最新非 alpha/beta 版本（rc 算数，与官方 next 通道同步）
    npm view @deepseek-ai/dsh versions --json 2>/dev/null \
      | grep -oE '"[0-9]+\.[0-9A-Za-z.\-]*"' | tr -d '"' \
      | grep -viE 'alpha|beta|canary|nightly|dev' | tail -1
  fi
}

update_dsh() {
  echo "── dsh"
  local cur new
  cur="$(grep -E '^DSH_VERSION=' "$DSH_ENV" 2>/dev/null | cut -d= -f2- | tr -d '\r')"
  new="$(dsh_target_version)"
  if [ -z "$new" ]; then
    echo "   查不到 npm 上的版本（离线？）。手动查：bash ../../dsh/check-update.sh"
    FAILED+=("dsh"); return
  fi
  echo "   当前 ${cur:-<未设置>}"
  echo "   候选 ${new}$([ "$STABLE" = "1" ] && echo ' (npm latest)' || echo ' (最新非 alpha)')"
  if [ "$cur" = "$new" ]; then
    echo "   已是最新"; return
  fi
  [ "$CHECK" = "1" ] && { echo "   [check] 不改动文件"; return; }
  cp "$DSH_ENV" "$DSH_ENV.bak-$STAMP" && echo "   已备份 dsh/.env -> dsh/.env.bak-$STAMP"
  sed -i "s|^DSH_VERSION=.*|DSH_VERSION=${new}|" "$DSH_ENV"
  TO_BUILD+=("dsh")
}

for s in openclaw hermes; do want "$s" && pin_latest "$s"; done
want dsh && update_dsh

if [ "$CHECK" = "1" ]; then
  echo; echo "（--check 模式，未做任何改动）"
  exit 0
fi

if [ ${#TO_BUILD[@]} -eq 0 ]; then
  echo; echo "── 没有需要重建的服务"
else
  # 必须串行：docker compose build 一次带多个服务时，任一失败会把其他的也 CANCEL 掉
  echo
  echo "── 重建镜像（串行）：${TO_BUILD[*]}"
  for svc in "${TO_BUILD[@]}"; do
    echo "   --- $svc"
    if ! docker compose build --pull "$svc"; then
      echo "   构建失败：$svc（已成功的服务有缓存，重跑会跳过）"
      FAILED+=("$svc")
    fi
  done
  echo "── 重启容器"
  docker compose up -d
fi

echo
echo "── 冒烟检查（401/302/200 都算活着；000 才是没起来）"
while IFS=: read -r svc port path; do
  code="$(curl -s -o /dev/null -m 6 -w '%{http_code}' "http://127.0.0.1:${port}${path}" || echo 000)"
  printf "   %-9s %-6s %-9s %s\n" "$svc" "$port" "$path" "$code"
done <<'EOF'
openclaw:18789:/
hermes:8642:/health
hermes:9119:/
dsh:3080:/
EOF

echo
echo "── token 上报守护（容器起来就自动恢复，无需重新接入）"
for p in "agents-openclaw-1 /home/node/.opentoken/daemon.log" \
         "agents-hermes-1 /opt/data/.opentoken/daemon.log" \
         "agents-dsh-1 /home/node/.opentoken/daemon.log"; do
  set -- $p
  printf '   %-18s ' "$1"
  MSYS_NO_PATHCONV=1 docker exec "$1" tail -1 "$2" 2>/dev/null || echo "<暂无>"
done

echo
echo "── 面板入口（dsh 的 token 每次重启都会变，所以要重新打印）"
bash docker/dashboards.sh || true

if [ ${#FAILED[@]} -gt 0 ]; then
  echo
  echo "以下服务未更新成功：${FAILED[*]}"
  echo "回滚用本次备份：${ENV_FILE}.bak-$STAMP / ${DSH_ENV}.bak-$STAMP"
  exit 1
fi
echo
echo "完成。"
