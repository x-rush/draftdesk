# opentoken（生财 token 上报）在 Docker 容器里的落地方式

容器里没有 systemd / launchd，所以 `opentoken service install` 一定失败。
正确做法是把上报守护挂到容器启动命令上——本目录的 `start.sh` 就是那个守护。

## 架构

一个共享只读卷 `opentoken-bin` 放着二进制 + `start.sh`，三个 agent 容器各自挂载，
各自以**自己的 `$HOME`** 起守护：

| 服务 | HOME | 扫描到的数据 | 账本落点（持久） |
|---|---|---|---|
| openclaw | `/home/node` | OpenClaw | `openclaw-data` 卷 → `/home/node/.opentoken` |
| hermes | `/opt/data` | Hermes | `hermes-data` 卷 → `/opt/data/.opentoken` |
| dsh | `/home/node` | DeepSeek Harness | 固化在 dsh 镜像 entrypoint + `opentoken-data` 卷 |

`HOME` 是关键：hermes 用默认 HOME 会报 `No supported tools detected`，
必须 `HOME=/opt/data` 才扫得到。

## 排查

```bash
# openclaw
docker exec agents-openclaw-1 sh -c 'tail -5 /home/node/.opentoken/daemon.log'

# hermes
docker exec agents-hermes-1 sh -c 'tail -5 /opt/data/.opentoken/daemon.log'

# dsh
docker exec agents-dsh-1 sh -c 'tail -5 /home/node/.opentoken/daemon.log'
```

看到 `uploaded N usage + M activity rows` 就是成功了。

单独看能扫到多少（不上传）：

```bash
docker exec agents-openclaw-1 /opt/opentoken/opentoken preview
docker exec agents-hermes-1  sh -c 'HOME=/opt/data /opt/opentoken/opentoken preview'
```

## 固定设备身份（防止重建多出设备）

`device_id` 缺失时 opentoken 会随机生成一个新的，而 tokenrank 的「设备管理」
把每个上报过的 device id 都登记成一台设备——容器重建或账本被清一次就多一台。

三个设备的 id 已经钉死在 env 里，`start.sh` / dsh `entrypoint.sh` 在启动时
发现 `device_id` 不存在就用它补回去：

| 服务 | 变量（写在哪） | 当前值 |
|---|---|---|
| openclaw | `OPENCLAW_TOKEN_DEVICE_ID`（agents/.env → compose 映射成 `OPENTOKEN_DEVICE_ID`） | `89f8c167638c96df` |
| hermes | `HERMES_TOKEN_DEVICE_ID`（同上） | `2a41923598419a16` |
| dsh | `OPENTOKEN_DEVICE_ID`（dsh/.env，env_file 直接注入） | `f66a80179e1af694` |

改这个值 = 换一台新设备，别乱动。验证方式：删掉 `device_id` 重启容器，看它是否自己变回来。

## 升级二进制

二进制存在卷里，不会随镜像更新。想升级就重灌一次卷（改完源脚本也要重灌）：

```bash
MSYS_NO_PATHCONV=1 docker run --rm --user root \
  -v agents_opentoken-bin:/opt/opentoken \
  -v /c/Users/77958/Projects/draftdesk/agents/opentoken:/src:ro \
  --entrypoint sh dsh:0.1.7-rc.2 -c '
  cp /usr/local/bin/opentoken /opt/opentoken/opentoken
  cp /src/start.sh /opt/opentoken/start.sh
  chmod 755 /opt/opentoken/opentoken /opt/opentoken/start.sh
  chown -R 1000:1000 /opt/opentoken'
```

或者让 opentoken 自己升：`docker exec agents-openclaw-1 /opt/opentoken/opentoken self-update`
（只改容器内那一份，卷里的不受影响，重建即回退——所以还是重灌卷更稳）。

## 踩过的坑

- **二进制下载后没有执行权限**：`curl -o` 出来的文件默认 644，直接跑就是 `Permission denied`，
  必须 `chmod +x`。
- **openclaw / dsh 以 node 用户运行**，写不了 `/usr/local/bin`，别往那里装。
- **hermes 的 command 已经被 s6 降权到 hermes 用户**：再套 `su` / `runuser` 会失败
  （`su: Authentication failure`、`runuser: may not be used by non-root users`），
  直接跑即可，只要给对 `HOME`。
- **s6 会清理普通后台进程**：hermes 那侧必须用 `setsid` 脱离会话，否则守护活不过启动阶段。
- **别用 sidecar 统一扫描**：实测把三个数据卷挂到同一个容器里扫，openclaw 和 dsh 正常，
  hermes 扫不到（疑似还依赖 `/opt/hermes` 安装目录）。必须各容器自扫。
- **改了 `start.sh` 一定要重灌共享卷**：容器用的是 `opentoken-bin` 卷里那份副本，
  改本地文件对容器**完全无效**（表现为新逻辑静默不生效，排查时容易误判成脚本写错）。
  重灌命令见上面「升级二进制」，注意必须加 `--entrypoint sh` 覆盖——
  dsh 镜像的 ENTRYPOINT 会忽略传入命令、自顾自地把 dsh web 拉起来，不加就白跑。
- **同步完要重启容器**：卷是只读挂载的，改了内容也得重建/重启才生效。
