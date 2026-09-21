# 拾题 DraftDesk 2

**社区版 · Early Preview**。面向个人的自托管研究与选题工作台，适合开发者和创作者试用、改进。真实模型输出质量与长期定时运行仍在验证中；当前不提供多租户、支付或公网登录保护，请保持本机访问。

一个个人优先、证据驱动的智能选题工作台。内置研究与 Hermes / OpenClaw 等外部工具使用相同的数据协议：资讯 → 证据 → 观点 → 可执行选题 / 应用实验。

## 启动

安装并启动 Docker Desktop 后，在项目目录运行：

```sh
git clone https://github.com/x-rush/draftdesk.git
cd draftdesk
docker compose up -d --build
```

正式本机地址 http://127.0.0.1:5173 。`start.cmd` 启动，`stop.cmd` 停止，`verify.cmd` 运行校验。宿主机无需 Node、Python、数据库或全局环境变量。

Next.js App Router / React / TypeScript 提供同源网页与 API；独立 Node Worker 运行长任务，SQLite WAL 保存任务、证据、结果与会话。数据库在 `data/draftdesk.sqlite`，不会随着容器重建丢失。电脑和 Docker 关闭时不采集，重启后只补当天到期任务。

## 首次使用

1. 模型与设置：填写百炼 Base URL、`ZHIPU/GLM-5.3-Flash` 和 API Key，保存后测试连接。不是阿里云 AccessKey ID/Secret。
2. 数据源：AIHOT 精选/产品动态 RSS、Google Trends 地域热榜、GitHub 仓库搜索和 Tavily；支持自定义公开 HTTPS RSS/Atom。网页搜索另需 Tavily Key。
3. 研究策略：调整受众、目标、关键词、域名、排除词、回看天数和预算，先手动运行。
4. 运行记录：查看来源失败、任务步骤、模型调用和用量。默认关闭每日定时，可按北京时间启用。
5. 每日发现：阅读个人影响、证据、未知项、下一步，收藏/编辑/讨论，再决定内容创作。

没有真实来源时不生成示例新闻；没有密钥时仍可使用外部证据导入、查看和编辑。启用模型功能必须完成真实连接。

## 研究质量

研究 Skills 已升级到 v1.1（外部提交协议保持 v1.0），按任务加载专项参考资料，来源与许可可追溯。内置 8 个语义评测场景及旧版/新版对照工具，使用方法见 `evals/README.md`。没有真实模型评测结果时不展示虚构通过率。

每次任务按版本加载 Skills：证据整理 → 资讯选题 / 趋势 / 应用 / 人物专项分析 → 独立审稿。结构不合格最多修复一次，总次数与预算仍受约束。硬检查会标记未知引用、虚构引文、单来源、未知发布时间、缺趋势指标或缺用户需求来源。待审结果仍可查看，只有通过当前检查的资讯/选题可手动公开。

规则检查和第二次模型审核不等于事实认证。全文未获取时只使用摘要，不声称亲测。不把媒体转载当独立需求样本、不把 Stars/热榜当收入、不把美国热词当中国需求。框架不保证模型每次输出优秀，真实效果应由自己的资料集持续评测。

## 外部智能体

在“外部接入”创建专用提交令牌，下载 Skills 包和 JSON Schema。令牌只用于 `POST /api/v1/intake`，可以单独撤销，服务端只保存散列。外部提交默认待审且私有；不会自行触发付费研究。

```sh
export DRAFTDESK_URL=http://127.0.0.1:5173
export DRAFTDESK_TOKEN=你的提交令牌
python skills/draftdesk-submit/scripts/submit.py research.json
```

环境变量只在运行工具的终端/容器配置，不必污染系统环境。协议例子见 `skills/draftdesk-submit/references/intake-example.json`。同一批次稳定使用 submissionId，重复提交不重复写入；同 ID 不同内容返回 409。

Hermes 可将技能目录放入 `~/.hermes/skills/`；OpenClaw 可放入其工作区 `skills/` 或用户技能目录。按各自当前官方文档安装，不自动替用户安装、创建日程或接通付费搜索。附带 Skill 描述了如何按工作台导出的策略运行外部每日研究。远程智能体需显式设置可达的安全入口；Docker 容器的 localhost 不是宿主机。

## 数据与边界

- 应用机会、人物、会话与外部原始证据始终私有。公开接口只返回显式公开且通过检查的资讯与选题投影。
- 本版只绑定 127.0.0.1，没有多用户登录、支付和公网租户隔离。不能直接作为多租户 SaaS 上线。
- 不自动爬取受登录/验证码/付费墙保护的公众号及国内平台。可用已授权外部工具、RSS 或手动证据导入补充。
- JSON 工作数据导出不含密钥；完整备份需先 `docker compose stop`，复制整个 `data` 目录（敏感），再启动。恢复时停止服务再替换该目录。不要在写入中直接复制单个 sqlite 文件。
- 旧版浏览器选题在首次访问同一地址时自动导入“我的选题库 / 旧版选题”，保留原字段，不删除旧浏览器存储。模型配置通过迁移脚本转入新数据库。
- 模型 token 按输入 UTF-8 字节加最大输出保守预留，实际用量单列；预留失败或取消不自动返还，防止重试绕预算。搜索次数单独上限。它不是人民币账单。
- 搜索与模型请求无自动无限重试；进程中断任务会在租约过期后标失败，而不是自动重复扣费。所有运行版本与中间分析可导出。

## 开发与验证

```sh
docker compose run --rm worker npm test
docker compose run --rm worker npm run check
docker compose build
```

需求与架构见 `PRD.md`、`DESIGN.md`、`ARCHITECTURE.md`；任务规程与方法来源在 `skills/`。贡献方式见 `CONTRIBUTING.md`，安全边界见 `SECURITY.md`，后续方向见 `ROADMAP.md`。

## 许可证

社区版采用 [MIT](LICENSE)，允许商业使用、修改与再分发，需保留版权和许可声明。研究方法中改编的第三方内容保留其声明，见 [技能来源](skills/PROVENANCE.md) 与 [第三方许可](skills/THIRD-PARTY-NOTICES.md)。搜索得到的文章、图片和其他外部素材不因本项目开源而获得转载授权。
