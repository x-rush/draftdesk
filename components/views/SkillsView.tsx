"use client";
// 研究 Skills 视图（PHASE 5 自 Workbench.tsx 纯移动拆出；JSX 与拆分前逐字一致）。
import { ArrowUpRight } from "lucide-react";
import type { Workspace } from "../useWorkspaceData";

export function SkillsView({ ws }: { ws: Workspace }) {
  const { skills, setSkill } = ws;
  return (
    <div className="skill-list">
      <p className="lead">项目 Skills v1.1 · 参考资料随任务加载并记录版本。已加入选题、趋势与需求判断评测；工程检查通过不等于真实模型质量验收。内容策划与需求研究方法改编来源：Corey Haines / marketingskills（MIT），完整来源与边界见下载包。</p>
      {skills.map((s) => (
        <button
          className="skill-row"
          key={s.id}
          onClick={() => setSkill(s)}
        >
          <div className="skill-index">
            {String(skills.indexOf(s) + 1).padStart(2, "0")}
          </div>
          <div>
            <h2>{s.name}</h2>
            <p>{s.purpose}</p>
            <small>
              {s.id} · v{s.version} · {s.digest}
            </small>
          </div>
          <ArrowUpRight size={20} />
        </button>
      ))}
    </div>
  );
}
