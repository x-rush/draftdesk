# 外部 Agent 安装、预检与研究流程

适用：用户授权将公开研究资料发送到指定 DraftDesk。研究能力来自当前 Agent，安装 Skill 不会安装搜索工具或创建付费账号。

## 安装与凭据

解压下载包，将 skills/ 下各技能目录安装到当前运行器的技能路径：OpenClaw 可使用工作区 skills/；Hermes 可使用 ~/.hermes/skills/。保留 references 和 scripts 的相对位置。运行器版本不同，以其实际配置为准。Python 脚本需要 Python 3。

令牌仅从 DRAFTDESK_TOKEN 环境变量读取；地址从 DRAFTDESK_URL 读取。不得打印令牌、写进研究文件或任务说明。宿主机默认 http://127.0.0.1:5173；同机 Docker Desktop 容器使用 http://host.docker.internal:5173。远程使用用户明确提供的 HTTPS 安全入口；不要自行修改端口、认证或网络防护。

## 先验证，后研究

1. 运行 `python skills/draftdesk-submit/scripts/preflight.py`，在实际 Agent 环境验证地址与提交令牌。只返回权限状态，不入库，不调用模型。
2. 检查自己是否有可用且已授权的搜索工具。没有就停止，说明工具缺口，不把语言模型已有知识当作网络搜索。
3. 用户授权试跑后只做一次真实搜索、最多两条公开证据。保留工具名称、查询、时间及来源供用户查看；协议 JSON 不要添加未声明的顶层字段。
4. 生成 sample.json，运行 `python skills/draftdesk-submit/scripts/preflight.py sample.json`。该接口验证结构和引用，不能证明事实或来源质量。没有合适材料时报告无结果，不伪造样例。
5. 展示小样本及验证结果后，按用户已有授权继续或等待正式研究授权。不要未经授权创建日程。

## 研究模式

从导出的计划读取 kind、goal、audience、keywords、excludeKeywords、includeDomains、lookbackDays、sourceIds 和预算。随配置包提供的 sources 包含具体来源，不通过提交令牌读取私人工作区。

- 仅采集：搜索→证据去重和来源核对→证据包，drafts=[]。工作台不会自动付费分析，由用户手动启动。
- 完整研究：搜索→evidence-curator→按 kind 选择 editorial-research / trend-research / opportunity-research / people-research→quality-editor 自审→证据和有效草稿。被自审否决的草稿不提交，但向用户说明原因；不要在包中自行赋予 ready、public 等状态。工作台接收后仍待核验，不自动重复生成。

资讯找一手更新和个人影响；应用找真实问题、替代方案及反例；趋势保留原始口径，缺少可比历史不编增速；人物先确认身份。预算内最多两次补证，计入 maxQueries。外部运行器自行执行搜索和模型限额；工作台内部额度不覆盖外部费用。缺口保留未知，可以零草稿。

## 提交和恢复

遵循下载的 JSON Schema 与 intake-example.json。先预检，再运行 submit.py。相同包重试沿用 submissionId，修改内容使用新 ID。HTTP 成功回执代表已接收，不代表已审核或已发布。脚本执行被运行器权限拦截时不要关闭防护；将结果保存在允许目录，交给用户已配置的可信提交适配器。

任务调度由用户明确选择 Agent 或工作台其中一方负责，避免双重搜罗。无预算、无来源、校验失败时停下，记录原因，不无限重试。
