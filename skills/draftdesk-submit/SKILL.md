---
name: draftdesk-submit
description: 将 Hermes、OpenClaw 或其他研究工具搜集的公开证据按 DraftDesk 1.0 协议提交到智能选题工作台。
metadata:
  version: "1.1.0"
---

# DraftDesk 外部研究与提交

首次接入、连接检查、小样本和完整研究模式按 [外部研究流程](references/agent-workflow.md) 执行。先运行 `scripts/preflight.py` 检查地址与权限；传入样例文件只预检，不入库。预检不代表搜索工具可用或事实通过审核。

运行依赖：Python 3、用户授权的 DraftDesk 地址与仅提交权限的令牌；研究能力由所在智能体提供。

## 何时使用

用户要求搜集 AI 资讯、趋势、产品/应用机会或作者公开作品，并将结果提交到已授权工作台。此 Skill 不提供付费搜索账号，不绕过登录/验证码/付费墙，不自动公开结果。

## 准备

读取用户的目标、受众、时间窗口、地区、关键词和限定来源。优先导入工作台“研究策略”页导出的计划。使用当前智能体已授权的搜索/浏览工具；如果缺工具或访问失败，记录缺口，不能伪装为完成。

## 收集步骤

1. 找第一手公告、公开说明与用户原话；聚合站用于发现，再尽可能回到原出处。
2. 记录标题、规范链接、发布时间（未知则省略）、采集时间、地域、语言、来源类型、正文层级。
3. excerpt 保留足以核对结论的短片段，遵守原站授权和引用限制，不提交整篇付费文章或敏感个人资料。
4. 热度有指标时保留原名、值、单位、窗口；没有数字就省略 metric，不编造指数。
5. 同源转载不当独立需求样本；用户抱怨与付费证据分开。
6. 根据 references/intake-example.json 组装 JSON。每条证据提供唯一临时 id，草稿只引用本提交内 id。优先只提交 evidence，交工作台统一分析。
7. submissionId 必须稳定；同一批重试使用同 ID 和原内容。改内容必须换新 ID。
8. 按用户已授权的目标发送；令牌通过环境变量读取，不写入 payload、日志、URL 或对话。

## 容易填错的协议字段

- sourceType 只允许 `official`、`media`、`community`、`product`、`repository`、`trend`、`other`。聚合目录用 product/other，个人博客按内容用 media/community/other；禁止自造 aggregator、blog、news 等枚举。
- contentLevel 只允许 fulltext、excerpt、headline；仅读搜索摘要时必须 excerpt，不能伪装全文。
- collectedAt 必填 UTC ISO 时间；publishedAt 不知道就省略，不能填空字符串或估计日期。
- 完整合同以工作台 GET /api/v1/schema 为准。HTTP 400 修正明确字段后用新的 submissionId 提交；同 ID 不得改变已成功收件的内容。

## 提交

`python scripts/submit.py result.json`

环境变量：DRAFTDESK_URL（例如 http://127.0.0.1:5173）、DRAFTDESK_TOKEN。远程提交使用 HTTPS；容器里的 localhost 指容器自身，用户需明确配置可达地址，不自行开放公网端口。

## 验收

HTTP 201/200 回执必须含 evidenceIds 与 status=pending-review。重复返回 duplicate=true 属成功重试。401 检查令牌，409 使用原内容重试或为新批次换 ID，400 修正数据合同。不要把“收到”说成“通过审核”或“已发布”。

## 可选日程

可让用户在 Hermes/OpenClaw 自己的调度功能里安排：按导出的策略研究 → 生成稳定日期提交 ID → 调用脚本 → 检查回执。不得未经授权注册持续任务；工作台自身也有独立内置日程，避免两边重复搜索。

## 创作活动扩展
工作台接受 kind=activity 的结构化草稿；先下载当前 /api/v1/schema，不沿用旧字段列表。也可只提交证据，由“AI 与 Vibe Coding 创作活动”策略分析。
四平台创作者中心中用户授权访问的活动可以提交原始规则、来源地址和采集时间；不要提交Cookie、登录令牌、手机号等账号信息。登录可见资料不冒充已公开抓取。必须记录投稿起止（非发奖时间）、年份、门槛、奖励条件；没有完整规则就标待核实。每活动3–5个不同且符合规则的内容方向，建议先读 activity-research/SKILL.md。不能登录的来源应报告不可访问，不猜活动或地址。
