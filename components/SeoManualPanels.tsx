"use client";
// 哥飞人工线两面板（R8-4② 批4；R10.54-② 从应用机会站点发现子导航迁入热词趋势——
// 词库线的人工触点归位词库页，老大 11-08「一步到位」）
import { useEffect, useState } from "react";
import { api } from "./ui";
import type { Workspace } from "./useWorkspaceData";

export function ManualReturnPanel({ ws }: { ws: Workspace }) {
  const seoEnabled = !!ws.data?.config?.seoDataSource?.enabled;
  const [raw, setRaw] = useState("");
  const [recent, setRecent] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const load = () => void api<any>("seo-terms/manual/recent").then((r) => setRecent(r.items || [])).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!seoEnabled) return null;
  return (
    <section className="surface" style={{ padding: "16px 18px", marginBottom: 14 }}>
      <p className="dash-label" style={{ marginTop: 0 }}>✋ 手动回传<span className="dash-label-sub">粘贴哥飞站内查询结果（JSON / Markdown 报告 / 每行「词 月搜 KD CPC」文本均可），✋手动数据权重最高，站群卡价值面板即时点亮</span></p>
      <textarea
        style={{ width: "100%", minHeight: 72, fontFamily: "monospace", fontSize: 12 }}
        placeholder={'JSON：[{"keyword":"ai agent","volume":880,"kd":12,"cpc":0.6}]' + "\n" + '或文本（每行）：ai agent  880  12  0.6'}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
      />
      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center" }}>
        <button disabled={busy || raw.trim().length < 2} onClick={() => {
          setBusy(true);
          setMsg(null);
          void api<any>("seo-terms/manual", { raw })
            .then((r) => { setMsg({ text: r.note || "已回传。", ok: true }); setRaw(""); load(); return ws.refresh(); })
            .catch((e) => setMsg({ text: "回传失败：" + (e as Error).message, ok: false }))
            .finally(() => setBusy(false));
        }}>{busy ? "回传中…" : "回传落库"}</button>
        {msg && <p role="status" style={{ margin: "8px 0 0", fontSize: 13, color: msg.ok ? "#1a7f4b" : "#8a3a3a" }}>{msg.ok ? "✓ " : "✕ "}{msg.text}</p>}
        {recent.length > 0 && (
          <span className="muted" style={{ fontSize: 12 }}>
            最近：{recent.map((r, i) => `${new Date(r.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} ${r.applied} 词${i < recent.length - 1 ? " · " : ""}`)}
          </span>
        )}
      </div>
    </section>
  );
}

export function TodayCheckPanel({ ws }: { ws: Workspace }) {
  const seoEnabled = !!ws.data?.config?.seoDataSource?.enabled;
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => { void api<any>("seo-terms/today").then((r) => setItems(r.items || [])).catch(() => setItems([])); }, []);
  if (!seoEnabled || items === null) return null;
  return (
    <section className="surface" style={{ padding: "16px 18px", marginBottom: 14 }}>
      <p className="dash-label" style={{ marginTop: 0 }}>📋 今日待查<span className="dash-label-sub">共享质量闸（strong+低竞争+obs≥5+未出标，英文优先）前 10 词——手动回传成功即从清单移除并点亮价值面板</span></p>
      {items.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>今日清单空：所有达标词都已出标或已回传。</p>
      ) : (
        <div className="discovery-list">
          {items.map((it) => (
            <article className="discovery-row" key={it.term} style={{ padding: "10px 4px" }}>
              <div className="row-content">
                <div className="row-meta">
                  <strong>{it.term}</strong>
                  <span>观测 {it.observations} 次</span>
                </div>
                <div style={{ fontSize: 12, marginTop: 4 }}>
                  {it.links.map((l: any) => <a key={l.label} className="text-button" style={{ padding: "0 6px 0 0" }} target="_blank" rel="noopener noreferrer" href={l.url}>{l.label} ↗</a>)}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>查完把结果粘到下方「✋ 手动回传」框即可落库点亮。</p>
    </section>
  );
}