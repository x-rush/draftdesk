"use client";
// 研究 Skills · 信号台版（完全重设计批）：
// ① 统计条（总数/研究执行/整理与审核/协作与提交）② 分类 chips 收进分节标签
// ③ Skill 卡 2 列网格（复用 plan-card 语言：分类与版本胶囊+名称+用途钳行+详情按钮）。
// 分类按 id 归组（研究执行四条线 / 整理与审核 / 协作与提交），纯展示层。
import { useState } from "react";
import { Handshake, FlaskConical, Paperclip, Puzzle } from "lucide-react";
import { ArrowUpRight } from "lucide-react";
import type { Workspace } from "../useWorkspaceData";

const SKILL_CATEGORY: Record<string, string> = {
  "activity-research": "research",
  "editorial-research": "research",
  "trend-research": "research",
  "opportunity-research": "research",
  "evidence-curator": "review",
  "quality-editor": "review",
  "discussion-partner": "collab",
  "draftdesk-submit": "collab",
};
const CATEGORY_LABELS: Record<string, string> = { research: "研究执行", review: "整理与审核", collab: "协作与提交" };

export function SkillsView({ ws }: { ws: Workspace }) {
  const { skills, setSkill } = ws;
  const [cat, setCat] = useState("");
  const count = (key: string) => skills.filter((s) => (SKILL_CATEGORY[s.id] ?? "research") === key).length;
  const visible = cat ? skills.filter((s) => (SKILL_CATEGORY[s.id] ?? "research") === cat) : skills;

  return (
    <>
      {/* R10 第4段：定位说明——方法论手册（内外部 AI 消费），入口在「高级」层级 */}
      <p className="dash-label" style={{ marginTop: 0 }}>
        <span className="dash-label-sub">方法论手册：内置与外部 AI 共用的研究/判定口径（Skill 包版本化）。本页是展示与核对入口，改判定标尺在「模型与设置 · 人设/aiPolicy」。</span>
      </p>
      {/* ① 统计条 */}
      <div className="stat-strip">
        <div className="stat-card accent"><strong>{skills.length}</strong><span><Puzzle size={13} /> 研究 Skills</span><small>包版本 v1.1 · 参考资料随任务加载并记录版本</small></div>
        <div className="stat-card"><strong>{count("research")}</strong><span><FlaskConical size={13} /> 研究执行</span><small>选题 / 趋势 / 机会 / 活动四条研究线</small></div>
        <div className="stat-card"><strong>{count("review")}</strong><span><Paperclip size={13} /> 整理与审核</span><small>去重核时间地域 · 拒绝大话与无据结论</small></div>
        <div className="stat-card"><strong>{count("collab")}</strong><span><Handshake size={13} /> 协作与提交</span><small>讨论搭档 · 外部智能体统一收件协议</small></div>
      </div>

      {/* ② 清单 */}
      <p className="dash-label"><span style={{ flex: "none" }}><Puzzle size={14} /> Skill 清单</span><span className="dash-label-sub">
        <button className={cat === "" ? "active" : ""} onClick={() => setCat("")}>全部 {skills.length}</button>
        {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
          <button key={key} className={cat === key ? "active" : ""} onClick={() => setCat(cat === key ? "" : key)}>{label} {count(key)}</button>
        ))}
        <span>工程检查通过不等于真实模型质量验收；方法改编来源 Corey Haines / marketingskills（MIT），完整来源与边界见下载包。</span>
      </span></p>
      <div className="plan-grid">
        {visible.map((s) => (
          <article className="plan-card" key={s.id}>
            <div className="plan-card-head">
              <span className="pill">{CATEGORY_LABELS[SKILL_CATEGORY[s.id] ?? "research"]}</span>
              <span className="pill">v{s.version}</span>
            </div>
            <h3 className="plan-name">{s.name}</h3>
            <p className="plan-goal">{s.purpose}</p>
            <div className="plan-foot">
              <small>{s.id} · 已加入评测：选题 / 趋势 / 需求判断</small>
              <div className="term-actions">
                <button onClick={() => setSkill(s)}>查看说明与数据合同 <ArrowUpRight size={14} /></button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </>
  );
}
