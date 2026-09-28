# agent 镜像里的 Playwright / Chromium

三个 agent 官方镜像都不带浏览器。要让它们能开网页、截图、做网页自动化，
必须把 Chromium 和它依赖的系统库**装进镜像层**。

## 为什么不能"让 agent 自己装"

- 容器可写层是临时的 —— 现场装的东西，容器一重建就没了
- Chromium 需要一批系统级 `.so`（libnss3 / libgbm / libasound / libcups …），
  共享卷只能放文件，**装不了系统库**
- openclaw / dsh 以 `node` 用户运行，写不进 `/usr/local` 之类的系统目录

所以唯一稳的做法是自建镜像：`FROM` 官方镜像，加一层安装。

## 文件

| 文件 | 作用 |
|---|---|
| `openclaw.Dockerfile` | openclaw + Playwright |
| `hermes.Dockerfile` | hermes + Playwright |
| `dsh` 镜像 | 直接在 `Projects/dsh/Dockerfile` 里加的同一段 |
| `browser-smoke.js` | 冒烟测试：起浏览器 → 渲染中文 → 截图 |
| `build-browsers.sh` | 一条龙：串行构建 → 起容器 → 冒烟 → 上报检查 → 打印面板入口 |
| `dashboards.sh` | 只打印三个面板的链接 + 登录凭据（`--open` 可直接开浏览器） |

浏览器二进制统一装在 `/opt/playwright-browsers`（环境变量 `PLAYWRIGHT_BROWSERS_PATH`），
属于镜像层，容器重建不丢。

## 构建与更新

在有正常外网（或代理）的终端里执行：

```bash
cd C:/Users/77958/Projects/draftdesk/agents
bash docker/build-browsers.sh      # 构建 + 起容器 + 冒烟，一条龙
```

等价的手动步骤：

```bash
docker compose build               # 三个一起（单个：docker compose build openclaw）
docker compose up -d
docker exec agents-openclaw-1 sh -c 'NODE_PATH=/usr/local/lib/node_modules node /opt/browser-smoke.js'
```

基础镜像的 digest 在 `.env`（`OPENCLAW_IMAGE` / `HERMES_IMAGE`）。

一键更新三个 agent（推荐入口，见下文）：

```bash
cd C:/Users/77958/Projects/draftdesk/agents
bash update.sh              # openclaw + hermes + dsh 全自动
bash update.sh --check      # 只看有没有新版，不动文件
bash update.sh openclaw     # 只更新一个
bash update.sh --stable     # dsh 用 npm latest 而不是最新 rc
```

它会：拉官方最新镜像取 digest 改 `.env`、查 npm 把 dsh 版本写进 `../../dsh/.env`、
**串行** `docker compose build --pull`（并行会导致失败的那个把其他也 CANCEL 掉）、
`up -d`，最后冒烟 + 检查上报守护 + 打印面板入口。

## 网络

默认**直连官方源**（deb.debian.org + cdn.playwright.dev），配合代理即可。
如果某天直连不通，两个 Dockerfile 里都留了换镜像源的注释段，放开就能用清华源。
中文字体（`fonts-wqy-microhei`）是单独一条 RUN 且允许失败，不会拖垮构建。

## 冒烟测试

```bash
docker exec agents-openclaw-1 sh -c 'NODE_PATH=/usr/local/lib/node_modules node /opt/browser-smoke.js'
```

看到 `OK | Chromium x.x | 文本: 浏览器可用 · 中文渲染测试` 就说明能用。
（镜像里已把 `browser-smoke.js` 复制到 `/opt/`）

## 面板入口与凭据

```bash
bash docker/dashboards.sh          # 只打印链接 + 账号密码 + 状态码
bash docker/dashboards.sh --open   # 顺手用默认浏览器打开三个面板
```

| 服务 | 入口 | 凭据从哪来 |
|---|---|---|
| openclaw | `http://127.0.0.1:18789/#token=…` | 脚本向容器要 `openclaw dashboard --json`，token 现签现取；拿不到就退回 `.env` 的 `OPENCLAW_GATEWAY_TOKEN` |
| hermes | `http://127.0.0.1:9119/`（跳 `/login`，选 Username & Password） | `.env` 的 `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` / `_PASSWORD`；脚本会真登一次做校验 |
| dsh | `http://127.0.0.1:3080/?token=…` | 容器启动日志里打印的一次性 token，**每次重启都会换**，脚本取最后一条 |

hermes 另外还开了一个 OpenAI 兼容接口 `http://127.0.0.1:8642/v1`，
鉴权是 `Authorization: Bearer <API_SERVER_KEY>`（也在 `.env`）。

状态码只看"活着没"：200 / 302（跳登录页）/ 401（缺 token）都算正常，
`--` 才是连不上。

## 坑

- **apt 保持官方源**：实测容器直连 `deb.debian.org` 只要 0.9s，不需要换；
  早年换清华源是遇到 `Ign → Err → Connection failed` 的临时措施，现在已移除换源段。
- **`--no-sandbox`**：容器里没有 user namespace，Chromium 自带沙箱起不来，
  直接 `chromium.launch()` 会报错，脚本里要加 `args: ['--no-sandbox']`。
- **中文字体**：用 `fonts-wqy-microhei`（56MB 的 `fonts-noto-cjk` 经常下到一半就断）。
  字体是**单独一条 RUN 且带 `|| true`**，装失败也不会拖垮整个构建，最坏是截图缺字。
- **npm 必须换源**：容器直连 `registry.npmjs.org` 约 15s 且高频 ECONNRESET；
  `registry.npmmirror.com` 约 4.5s 稳定。宿主那个 127.0.0.1 的代理**不会**透传给容器。
- **构建要串行**：`docker compose build` 一次跑三个时，任一失败会把另外两个也 CANCEL
  掉（实测白跑 7 分钟）。build-browsers.sh 现在是 `for svc in dsh openclaw hermes` 逐个跑。
- **hermes 不要改 USER**：它的 s6 entrypoint 需要 root 来降权到 hermes 用户，
  在 Dockerfile 里 `USER hermes` 会让它起不来。
