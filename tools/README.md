# tools：公共服务层（dailyhot / searxng）

给三个 agent 和工作台提供公共能力，都在共享网络 `stack-net` 上，服务名即 DNS：

| 服务 | 内网地址 | 宿主端口 | 镜像怎么定的 |
|---|---|---|---|
| dailyhot | `http://dailyhot:6688` | 无（仅内网） | `compose.yaml` 里按 **sha256 digest** 固定 |
| searxng | `http://searxng:8080` | `127.0.0.1:8080` | `:latest` 标签，**未锁 digest** |

## 更新

```bash
cd C:/Users/77958/Projects/draftdesk/tools
bash update.sh              # 两个一起更新
bash update.sh searxng      # 只更新一个
bash update.sh --check      # 只看有没有新版，不动任何文件
```

脚本做的事：

1. 先记下**运行容器正在用的镜像 ID**（不能拿标签比——`docker pull` 会把标签挪到新镜像上，
   pull 之后再比永远相等，会误判"已是最新"、容器永远不换镜像）。
2. `docker pull <repo>:latest`，取新镜像 ID 与 digest。
3. dailyhot 是 digest 固定 → 改写 `compose.yaml` 的 image 行；searxng 是 `:latest` → 不用改文件。
4. `docker compose up -d <changed>`，然后探活：
   - searxng：`curl 127.0.0.1:8080/healthz`（期望 200）
   - dailyhot：没有宿主端口，从同网络的容器里探
     `docker exec agents-hermes-1 sh -c "curl -s -o /dev/null -w '%{http_code}' http://dailyhot:6688/"`

**回滚**：脚本把 `compose.yaml` 备份成 `compose.yaml.bak-<时间戳>`。
digest 固定的服务把旧 digest 抄回去再 `docker compose up -d <服务>` 即可；
`:latest` 的服务要靠磁盘上的旧镜像 ID：`docker compose up -d --no-create` 不行，
改 compose 里 image 为旧镜像 ID（`sha256:...`）再 up -d，或 `docker tag <旧ID> searxng/searxng:rollback` 后改引用。

## 坑

- **searxng 用 `:latest`，`docker compose up -d` 不会自动拉新镜像**（镜像已存在时 Docker 不拉）。
  必须显式 `docker compose pull searxng`，update.sh 已经处理。
- **searxng 大版本可能改 settings.yml 格式**。配置单一来源是
  `../search/settings.yml`（只读挂进容器）。升级后搜索报错先看
  `docker compose logs --tail=50 searxng`。
- 日志里这几条是**常驻噪音，可忽略**：`ahmia / torch: can't register engine`、
  `missing config file: limiter.toml`、`X-Forwarded-For nor X-Real-IP header is set!`。
- searxng 的缓存卷复用退役项目留下的 `draftdesk-search_searxng-cache`（external），别删。

## 三个 agent 的更新

不在这里，走 `../agents/update.sh`（openclaw / hermes 自动锁最新 digest 并重建带
Playwright 的自建镜像；dsh 本地构建，版本在 `../../dsh/.env` 的 `DSH_VERSION`）。
重建需要外网（npm + Playwright CDN），且容器用不上宿主的 127.0.0.1 代理——
如果卡住，把命令贴到开了 VPN 的外部终端里跑。
