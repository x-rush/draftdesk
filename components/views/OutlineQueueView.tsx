"use client";
// 每日发现 · 选题待拍队列（信息架构 v2-1）：
// outlines(decision=pending) 按综合分降序；卡片直接拍板，拍完移出。
// 综合评分 = 证据数 + suggestions 评分均值（派生式，schema 预留 score 字段位待外部 Agent）。
import { useState } from "react";
import type { Workspace, Snapshot } from "../useWorkspaceData";
import { ArrowUpRight } from "lucide-react";
import { Drawer, Empty, api, date } from "../ui";
import { useListKeyboardShortcuts } from "../useListKeyboardShortcuts";

export function outlineScore(o: any): number {
  const scores = (o.suggestions || []).map((s: any) => s.score).filter((n: any) => typeof n === "number");
  const avg = scores.length ? scores.reduce((a: number, b: number) => a + b, 0) / scores.length : 0;
  return (o.evidenceRefs?.length || 0) * 0.5 + avg;
}

export function OutlineQueueView({ ws, data }: { ws: Workspace; data: Snapshot }) {
  const { outlines, clusters, setNotice, busy, navigate } = ws;
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const pending = outlines
    .filter((o) => o.decision === "pending")
    .sort((a, b) => outlineScore(b) - outlineScore(a) || b.createdAt.localeCompare(a.createdAt));
  const clusterOf = (o: any) => clusters.find((c) => c.id === o.clusterId);
  useListKeyboardShortcuts(".discovery-row", { approve: () => pending[0] && decide(pending[0], "approved"), archive: () => pending[0] && decide(pending[0], "rejected", "其他"), discuss: () => pending[0] && setDetail(pending[0]) }, pending.length > 0);

  async function decide(o: any, decision: string, rejectReason?: string) {
    await api("outlines/" + o.id + "/decision", { decision, ...(rejectReason ? { rejectReason } : {}) });
    await ws.refresh();
  }

  const totalToday = outlines.filter((o) => o.decision !== "pending").length + pending.length;
  const doneToday = outlines.filter((o) => o.decision !== "pending").length;
  return (
    <>
      {totalToday > 0 && <div className="queue-progress" style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)" }}><span>今天还剩 {pending.length} 条待拍</span><span>已处理 {doneToday}/{totalToday}</span></div>
        <div style={{ height: 6, background: "var(--line)", borderRadius: 3 }}><div style={{ height: 6, borderRadius: 3, background: "var(--ink)", width: Math.round((doneToday / totalToday) * 100) + "%" }} /></div>
      </div>}
      {pending.length === 0 ? (
        <Empty title="今天还没有新选题。">
          去看看<button className="text-button" onClick={() => navigate("hotspots")}>热点资讯</button>找灵感 → 讨论或推进即可生成待拍选题。
        </Empty>
      ) : (
        <div className="discovery-list">
          {pending.map((o) => {
            const cluster = clusterOf(o);
            return (
              <article className="discovery-row" key={o.id}>
                <div className="row-number">
                  {String(outlineScore(o).toFixed(1))}
                </div>
                <div className="row-content">
                  <div className="row-meta">
                    <span>{o.platform}</span>
                    {cluster && cluster.id !== "clu-inbox" && <span>{cluster.topic}</span>}
                    {cluster && cluster.id === "clu-inbox" && <span>选题收集箱</span>}
                    <span>{date(o.createdAt)}</span>
                    {o.producedBy && <span>{o.producedBy}</span>}
                  </div>
                  <button className="article-title" onClick={() => setDetail(o)}>
                    {o.title}
                  </button>
                  <p>{o.keyPoints?.[0] || "暂无写作角度；可进讨论补齐。"}</p>
                  <div className="tags">
                    {(o.evidenceRefs || []).slice(0, 3).map((ref: string) => (
                      <a key={ref} href={ref} target="_blank" rel="noopener noreferrer">数据源 ↗</a>
                    ))}
                    {(o.evidenceRefs?.length || 0) > 3 && <span>+{o.evidenceRefs.length - 3}</span>}
                  </div>
                </div>
                <div className="row-side">
                  <small>{o.evidenceRefs?.length || 0} 条数据源</small>
                  <div style={{ display: "flex", gap: 6 }}>
                    <button disabled={busy} onClick={() => void decide(o, "approved").then(() => setNotice("已通过，进入选题库。"))}>通过</button>
                    <button disabled={busy} onClick={() => setReasonFor(reasonFor === o.id ? null : o.id)}>否决</button>
                    <button disabled={busy} onClick={() => void decide(o, "deferred")}>暂缓</button>
                  </div>
                  {reasonFor === o.id && (
                    <select aria-label={"否决原因 " + o.title} defaultValue="" onChange={(e) => { const v = e.target.value; if (v) { setReasonFor(null); void decide(o, "rejected", v); } }} style={{ marginTop: 6 }}>
                      <option value="">选否决原因…</option>
                      <option value="off-domain">超出领域</option>
                      <option value="no-ai-signal">没有 AI 信号</option>
                      <option value="已写过">已经写过</option>
                      <option value="写不透">写不透</option>
                      <option value="不感兴趣">不感兴趣</option>
                      <option value="其他">其他</option>
                    </select>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      {detail && <OutlineDrawer outline={detail} cluster={clusterOf(detail)} onClose={() => setDetail(null)} onDecide={(d, rr) => decide(detail, d, rr)} />}
    </>
  );
}

function OutlineDrawer({ outline: o, cluster, onClose, onDecide }: { outline: any; cluster: any; onClose: () => void; onDecide: (d: string, rr?: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  return (
    <Drawer
      title={o.title}
      subtitle={`${o.platform} · ${cluster ? cluster.topic : "选题收集箱"} · ${date(o.createdAt)}`}
      onClose={onClose}
      wide
    >
      <div className="detail-actions">
        <button className="primary" disabled={busy} onClick={() => void onDecide("approved").then(onClose)}>通过</button>
        <button disabled={busy} onClick={() => void onDecide("deferred").then(onClose)}>暂缓</button>
        <button disabled={busy} onClick={() => void onDecide("rejected", "其他").then(onClose)}>否决</button>
      </div>
      <p className="lead">{o.keyPoints?.length ? o.keyPoints.join("；") : "暂无要点。"}</p>
      {o.draftBody && <div className="draft-preview"><h3>草稿正文</h3><pre style={{ whiteSpace: "pre-wrap" }}>{o.draftBody}</pre></div>}
      <section>
        <h3>数据源（{o.evidenceRefs?.length || 0}）</h3>
        {(o.evidenceRefs || []).map((ref: string) => (
          <p key={ref}><a href={ref} target="_blank" rel="noopener noreferrer">{ref} ↗</a></p>
        ))}
      </section>
      {!!o.suggestions?.length && (
        <section>
          <h3>外部建议</h3>
          {o.suggestions.map((s: any, i: number) => (
            <div className="claim" key={i}>
              <span className="pill">{s.by}</span>
              <p>{s.verdict}{typeof s.score === "number" ? ` · 评分 ${s.score}` : ""}{s.reason ? ` · ${s.reason}` : ""}</p>
            </div>
          ))}
        </section>
      )}
      <p className="muted">当前状态：{({pending:"待决策",approved:"已通过",drafting:"写作中",published:"已发布",rejected:"已否决",deferred:"已暂缓"} as Record<string,string>)[o.decision] || o.decision}</p>
    </Drawer>
  );
}
