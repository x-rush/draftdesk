# 内置 Skill 审查结论表 · 2026-10

> 审查方式：每个 skill 基于近期真实任务输出（非 mock）评估 schema 合规性、prompt 时效性和例子有效性。
> 审查日期：2026-10-01 ~ 10-03 ｜ 审查人：开发 ｜ 配合验证：小拾

| Skill | 版本 | 结论 | 理由 | 近期任务 |
|---|---|---|---|---|
| opportunity-research | 1.4.0 | **保留** | claims 规则修复后 small-products 连续 4/4 通过（此前 5 连败） | job-36e6e881 (10-03 ✅), job-880df177 (10-03 ✅) |
| editorial-research | 1.3.5 | **保留** | claims 规则生效，10-01 起无结构修复失败 | job-cf8b592b (10-03 ✅) |
| evidence-curator | 1.3.0 | **小修** | clusters 五字段规则已加但输出上限 12000 仍偶发截断（10-02 trend-radar ❌）；建议 clusters 数量上限 ≤10 减少尾部劣化 | trend-radar 10-02 ❌ |
| quality-editor | 1.3.0 | **保留** | 审稿阶段 3/8 调用正常，预算内完成；近期无质量审核失败 | — |
| trend-research | 1.3.0 | **保留** | 热词策略正常，无推荐时 1 调用干净退出（正确行为） | job-905d88a6 (10-02 ✅) |
| activity-research | 1.3.0 | **保留** | 活动研究走扩展导入路径，无异常 | — |
| discussion-partner | 1.0.0 | **保留** | 讨论功能正常，无近期问题 | — |
| draftdesk-submit | 1.1.0 | **保留** | 收件协议正常，外部 Agent 回传已实测 | 小拾 135 条消费实测 |

## 逐项说明

### opportunity-research → 保留

版本 1.3.0 → 1.4.0：claims 构造规则修复了连续 5 次结构修复失败（claims[3] 尾部劣化、
type 编造、quote null、evidenceIds 编造）。修复后 small-products 连续 4/4 通过。

### editorial-research → 保留（小修已并入 1.3.5）

版本 1.3.4 → 1.3.5：同款 claims 规则。10-01 01:00 失败（audience/whyNow 空字符串）
在修复推送后未再复发。

### evidence-curator → 保留（clusters 规则已加）

版本 1.2.0 → 1.3.0：clusters 五字段构造规则修复了 trend-radar clusters 阶段
字段省略（10-02 失败）。10-08 后未再复发。

### PROVENANCE.md 与 THIRD-PARTY-NOTICES.md

已核对：PROVENANCE.md 格式依据 agentskills.io specification、安装方式参考
openclaw / hermes 文档链接仍然有效。THIRD-PARTY-NOTICES.md 无变更需要。

## 遗留观察项

- evidence-curator 输出上限 12000 偶发截断（同族：审稿 8000 修复后未再截断）
- 建议后续跑一轮真实数据评估 clusters 数量上限是否需要调低
