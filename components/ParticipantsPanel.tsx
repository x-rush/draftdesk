"use client";
// 参与方管理面板（信息架构 v2-8）：渲染 config.participants（内置 AI / 外部 Agent /
// human），支持启停与读写开关；未登记来源显示为默认放行。
import { useState } from "react";
import { api, Field } from "./ui";

const PARTICIPANT_LABELS: Record<string, string> = {
  "builtin-ai": "内置 AI（builtin 管线产出）",
  human: "人工操作（UI 归档/拍板）",
};

export function ParticipantsPanel({ config, onChange }: { config: any; onChange: () => Promise<void> }) {
  const participants: Record<string, { enabled?: boolean; canRead?: boolean; canWrite?: boolean }> = config?.participants || {};
  const [busy, setBusy] = useState(false);
  const known = Object.keys(participants);
  async function setParticipant(key: string, patch: { enabled?: boolean; canWrite?: boolean }) {
    setBusy(true);
    try {
      const next = { ...participants, [key]: { ...participants[key], ...patch } };
      await api("config", { ...config, participants: next });
      await onChange();
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="surface">
      <h2>参与方</h2>
      <p className="muted">
        按来源控制写回：enabled=false 直接 403 停用；canWrite=false 只读。未登记来源默认放行（向后兼容）。
      </p>
      {!known.length && <p className="muted">尚无登记的参与方——外部 Agent 首次写回后自动登记，或等待小拾写入。</p>}
      {known.map((key) => {
        const p = participants[key];
        const label = PARTICIPANT_LABELS[key] || key;
        return (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: "1px solid var(--line)", flexWrap: "wrap" }}>
            <strong style={{ flex: 1, minWidth: 180 }}>{label}</strong>
            <label className="check"><input type="checkbox" checked={p.enabled !== false} disabled={busy} onChange={(e) => void setParticipant(key, { enabled: e.target.checked })} />启用</label>
            <label className="check"><input type="checkbox" checked={p.canWrite !== false} disabled={busy} onChange={(e) => void setParticipant(key, { canWrite: e.target.checked })} />可写回</label>
          </div>
        );
      })}
    </section>
  );
}
