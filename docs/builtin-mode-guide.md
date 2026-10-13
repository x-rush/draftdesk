# 内置模式切换指南

## 两种消费执行方

| 模式 | 谁做初筛/聚合/大纲 | 谁做消费标记 | 适用场景 |
|---|---|---|---|
| **external**（推荐） | 外部 Agent（小拾等） | 外部 Agent | 已有 OpenClaw / Hermes 等个人助理的用户；避免内置 AI 与外部 Agent 重复消耗模型额度 |
| **builtin** | 内置 AI（每晚 01:00-01:30 定时） | 内置 janitor（自动回收） | 没有外部 Agent 的用户；开源社区新用户默认路径 |

## 前置条件

| | external | builtin |
|---|---|---|
| Agent 运行器 | 需要（OpenClaw / Hermes 等） | 不需要 |
| 模型 API Key | Agent 运行器自行配置 | 工作台「设置」页百炼 Key |
| 连接令牌 | read + suggest + consume | 无需令牌 |
| 浏览器扩展 | 可选（活动采集用） | 可选 |

## 切换步骤

### external → builtin

1. 「研究策略」→ 关闭不需要的策略的「每天自动运行」
2. 「设置」→ 消费执行方 → 切到 **内置管线**
3. 「外部接入」→ 撤销不需要的 Agent 令牌
4. 外部 Agent 停止写回后，内置管线从下一轮定时开始接管

### builtin → external

1. 确认已有可用的 Agent 运行器和连接令牌（read + suggest + consume）
2. 「外部接入」→ 用 Agent 写回聚合结果和大纲
3. 「研究策略」→ 关闭对应策略的「每天自动运行」（切到 external 后内置分析停用）
4. 设置页确认 consumerMode = external

## 混合模式

两条路径可并存：内置管线照常采集（planMode=collect），外部 Agent 负责分析和消费。
产出按 producedBy 区分（内置 AI / agent:名称 / 人工），审查台可按来源筛选。
切回 collect-and-analyze 后内置分析恢复，与外部 Agent 的产出并存（按 producedBy 区分）。

## 预算影响

| 模式 | 模型调用 | 说明 |
|---|---|---|
| external + collect | 零（内置不跑） | Agent 侧费用由 Agent 运行器承担 |
| external + collect-and-analyze | 内置与外部并存，可能重复消耗 | 建议关闭其中一个 |
| builtin + collect-and-analyze | 每策略 ≤ maxModelCalls | 由工作台预算控制 |


## 成本分级与热词判定（2026-10 起）

内置模型的调用按用途分档记账：判断/分类类（热词提取、相关性判定）走 **cheap**，产出类（研究/草稿/讨论）走 **full**；cheap 连续 2 次不满足输出合同时自动升 full 重试一次并记「升档」。按日台账见「模型与设置→每日成本看板」（今日/昨日调用、tokens、cheap/full 拆分、升档次数，超昨日 150% 标黄）。

热词链路的判定同样内置：每日整理时对词库中未判定词按 persona 标尺回填 💎强相关/○弱相关/🚫圈外 三档（只写档位不虚增观测）；只有 strong 词回流挖掘种子，off 词绝不回流。三档标尺可在 persona 配置里自定义：`config.persona.termPolicy`（strongHint/weakHint/offHint + redLine 红线词）给了就以它覆盖内置默认，redLine 命中的词由硬规则强制 off；不配则用内置标尺。

## 选题产出兜底链（approved → 第一版大纲）

选题的「第一版大纲」按消费执行方联动，两边不双跑：

| 模式 | 谁写第一版大纲 | 时机 |
|---|---|---|
| **external** | 外部 Agent（按 `skills/prompts/outline-matrix.md` 提示词矩阵，平台 × 题材双标注提交） | Agent 自己的调度；接口与示例见[外部 Agent 接入指南](agent-integration.md)「大纲提交」节 |
| **builtin** | 内置 AI 每小时自动跑：approved 且无草稿的选题按「平台模板 × 题材角度」cheap 档出稿（keyPoints/outline/draftBody），写完自动推进到「写作中」 | approved 后最迟 1 小时内 |

「模型与设置」里的 aiPolicy.draft 只是档位说明，真正的开关是消费执行方：external 时内置大纲兜底停用（外部 Agent 没交稿的 approved 选题保持在「已通过」等待），builtin 时自动接管。题材由 LLM 初标（六类），审查台题材徽章可点改纠偏。
