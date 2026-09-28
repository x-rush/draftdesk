#!/usr/bin/env bash
# 更新 tools 组两个公共服务：dailyhot / searxng
#
#   dailyhot : compose 里按 sha256 digest 固定 → 拉 latest 取新 digest 并改写 compose.yaml
#   searxng  : compose 里是 :latest 标签     → 直接 pull + up -d 即可
#
# 用法（在能正常访问外网的终端里跑）：
#   cd C:/Users/77958/Projects/draftdesk/tools
#   bash update.sh              # 两个都更新
#   bash update.sh dailyhot     # 只更新 dailyhot
#   bash update.sh --check      # 只看看有没有新版，不改动任何文件
#
# 失败回滚：脚本先把 compose.yaml 备份成 compose.yaml.bak-<时间戳>。
#          改回去后 `docker compose up -d <服务>` 即可。

set -uo pipefail
cd "$(dirname "$0")"

COMPOSE=compose.yaml
STAMP="$(date +%Y%m%d-%H%M%S)"
CHECK=0
TARGETS=()

for a in "$@"; do
  case "$a" in
    --check) CHECK=1 ;;
    dailyhot|searxng) TARGETS+=("$a") ;;
    *) echo "未知参数：$a（可用：dailyhot / searxng / --check）"; exit 1 ;;
  esac
done
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=(dailyhot searxng)

# 镜像仓库（compose 里 dailyhot 用 digest、searxng 用标签，这里统一用标签去拉最新）
declare -A REPO=(
  [dailyhot]="imsyy/dailyhot-api:latest"
  [searxng]="searxng/searxng:latest"
)

# 取某个服务在 compose.yaml 里的 image 行内容 + 行号
svc_image() { # $1=服务名 → 输出 "行号 内容"
  awk -v s="$1" '
    $0 ~ "^  "s":" {f=1; next}
    f && /^    image:/ {print NR" "$2; exit}
  ' "$COMPOSE"
}

set_image() { # $1=行号 $2=新值
  sed -i "${1}s|.*|    image: ${2}|" "$COMPOSE"
}

CHANGED=()
for svc in "${TARGETS[@]}"; do
  read -r LN CUR < <(svc_image "$svc")
  if [ -z "${LN:-}" ]; then echo "── $svc：在 $COMPOSE 里没找到 image 行，跳过"; continue; fi

  echo "── $svc：当前 $CUR"
  # 不能拿标签去比：pull 会把标签挪到新镜像上，pull 之后再比永远相等。
  # 正确做法是比「运行容器正在用的镜像 ID」和「刚拉下来的镜像 ID」。
  CID="$(docker compose ps -q "$svc" 2>/dev/null | head -1)"
  RUN_ID="$(docker inspect "$CID" --format '{{.Image}}' 2>/dev/null || true)"

  echo "     拉取 ${REPO[$svc]}"
  if ! docker pull "${REPO[$svc]}" >/dev/null 2>&1; then
    echo "     拉取失败（网络/代理？）。手动重试：docker pull ${REPO[$svc]}"
    continue
  fi

  NEW_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${REPO[$svc]}" 2>/dev/null || true)"
  CREATED="$(docker image inspect "${REPO[$svc]}" --format '{{.Created}}' 2>/dev/null | cut -dT -f1)"
  NEW_ID="$(docker image inspect "${REPO[$svc]}" --format '{{.Id}}' 2>/dev/null || true)"
  [ -z "$NEW_DIGEST" ] && { echo "     取不到 digest，跳过"; continue; }

  if [ -n "$RUN_ID" ] && [ "$RUN_ID" = "$NEW_ID" ]; then
    echo "     已是最新（运行镜像与最新一致，构建于 ${CREATED}）"
    continue
  fi

  echo "     新版本可用（构建于 ${CREATED}）"
  echo "       运行中的镜像 ${RUN_ID:-<容器未运行>}"
  echo "       最新镜像     ${NEW_ID}"

  if [ "$CHECK" = "1" ]; then echo "     [check] 不改动文件"; continue; fi

  [ ! -f "$COMPOSE.bak-$STAMP" ] && cp "$COMPOSE" "$COMPOSE.bak-$STAMP" \
    && echo "     已备份 $COMPOSE -> $COMPOSE.bak-$STAMP"

  # dailyhot 是 digest 固定，必须改写 compose 才生效；searxng 是 :latest，pull 完 up -d 就行
  case "$CUR" in
    *@sha256:*) set_image "$LN" "$NEW_DIGEST" ;;
    *)          : ;; # 标签引用不用改文件
  esac
  CHANGED+=("$svc")
done

if [ "$CHECK" = "1" ]; then echo; echo "（--check 模式，未做任何改动）"; exit 0; fi

if [ ${#CHANGED[@]} -eq 0 ]; then
  echo "── 无需重启：没有服务发生变化"
  exit 0
fi

echo "── 应用更新：${CHANGED[*]}"
docker compose up -d "${CHANGED[@]}"

echo
echo "── 健康检查"
sleep 6
# dailyhot 没有宿主端口，只能从 stack-net 里的容器探；searxng 有宿主 /healthz
if printf '%s\n' "${CHANGED[@]}" | grep -q dailyhot; then
  code="$(MSYS_NO_PATHCONV=1 docker exec agents-hermes-1 \
    sh -c "curl -s -o /dev/null -m 8 -w '%{http_code}' http://dailyhot:6688/" 2>/dev/null || echo 000)"
  printf '   %-9s %-22s %s\n' dailyhot "http://dailyhot:6688/" "$code"
fi
if printf '%s\n' "${CHANGED[@]}" | grep -q searxng; then
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' "http://127.0.0.1:${SEARXNG_PORT:-8080}/healthz" || echo 000)"
  printf '   %-9s %-22s %s\n' searxng "127.0.0.1:${SEARXNG_PORT:-8080}/healthz" "$code"
  echo "   searxng 用的是 :latest（未锁 digest），大版本可能改 settings.yml 格式。"
  echo "   若搜索报错先看：docker compose logs --tail=50 searxng"
  echo "   配置单一来源：../search/settings.yml（只读挂载进容器）"
fi
echo "   200 即正常；000 表示服务没起来。"
