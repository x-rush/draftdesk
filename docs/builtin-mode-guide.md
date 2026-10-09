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
