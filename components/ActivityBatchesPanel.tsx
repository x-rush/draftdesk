"use client";
// Part 7 UI（信息架构 v2-7）：创作活动页新增「采集批次 · AI 整理」区块——
// 分类徽章（外部 Agent 写入）、pin 置顶、三按钮（讨论/归档=标记不感兴趣/推进=转 outline）。
import { PLATFORM_KEYS, platformLabel } from "../core/platforms";
import { useState } from "react";
import { api, date } from "./ui";
import { ArchiveButton } from "./ActionButtons";
import { Select } from "./Select";

export function ActivityBatchesPanel({ ws, data }: { ws: any; data: any }) {
  const batches: any[] = data.activityBatches || [];
  const clusters: any[] = ws.clusters || [];
  const [ignored, setIgnored] = useState<string[]>([]);
  const [promoteBatch, setPromoteBatch] = useState<string | null>(null);
  const [platform, setPlatform] = useState("公众号");
  // R10.46④：归档已持久化（activity-categories reason=用户标记不感兴趣）——面板过滤掉，
  // 刷新不再复活（此前仅本地 hidden）。
  const visible = batches.filter((b) => !ignored.includes(b.id) && b.reason !== "用户标记不感兴趣");
  if (!batches.length) return null;
  return (
    <section className="surface" style={{ marginBottom: 14 }}>
      <h2>采集批次 · AI 整理</h2>
      <p className="muted">外部 Agent 写入的分类与置顶；pin 的批次排前。推进可把活动激励内容转为待拍选题。</p>
      {visible.map((b) => (
        <div key={b.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
          {b.pin && <span className="pill">📌 置顶</span>}
          <span className="pill">{b.category || "未分类"}</span>
          <strong style={{ flex: 1 }}>{b.platform} · {b.count} 条 <small>{date(b.receivedAt)}{b.reason ? ` · ${b.reason}` : ""}</small></strong>
          <button aria-label={`讨论：${b.platform} 活动批次`} onClick={() => { const first = b; ws.setDiscussionContext({ title: `${first.platform} 活动批次（${first.count} 条）`, url: "", source: first.platform }); ws.navigate("chat"); }}>讨论</button>
          <button aria-label={`推进：${b.platform} 活动批次`} onClick={() => setPromoteBatch(promoteBatch === b.id ? null : b.id)}>推进</button>
          <ArchiveButton label="归档" onConfirm={() => { setIgnored([...ignored, b.id]); void ws.act(async () => { await api("activity-batches/archive", { batchId: b.id }); ws.setNotice("批次已归档（标记不感兴趣，置顶取消）。可通过刷新页面在全部列表查看。"); }); }} />
        </div>
      ))}
      {promoteBatch && (() => {
        const b = batches.find((x) => x.id === promoteBatch)!;
        return <div style={{ display: "grid", gap: 6, padding: 9, border: "1px solid var(--line)", borderRadius: 9, marginTop: 6 }}>
          <Select aria-label="适配平台" value={platform} onChange={e => setPlatform(e.target.value)}>{PLATFORM_KEYS.map(p => <option key={p} value={p}>{platformLabel(p)}</option>)}</Select>
          <button className="primary" disabled={ws.busy} onClick={() => void ws.act(async () => {
            await api("outlines", { clusterId: "clu-inbox", platform, contentType: "活动解读", title: `${b.platform} 活动激励整理（${b.count} 条）`, keyPoints: [], evidenceRefs: [] });
            ws.setNotice("活动批次已转为待拍选题。");
          })}>转为待拍选题（进每日发现）</button>
        </div>;
      })()}
    </section>
  );
}
