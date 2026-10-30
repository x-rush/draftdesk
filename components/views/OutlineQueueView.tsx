"use client";
// 每日发现 · 选题待拍队列（信息架构 v2-1）：
// outlines(decision=pending) 按综合分降序；卡片直接拍板，拍完移出。
// 综合评分 = 证据数 + suggestions 评分均值（派生式，schema 预留 score 字段位待外部 Agent）。
import { useState } from "react";
import { platformLabel, categoryLabel, PLATFORM_KEYS, PLATFORM_LABELS, CATEGORY_KEYS, CATEGORY_LABELS } from "../../core/platforms";
import { MessageContent } from "../MessageContent";
import type { Workspace, Snapshot } from "../useWorkspaceData";
import { Select } from "../Select";
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
  // 数据治理（R10.35）：同选题聚合——此处都是大纲裸行（无 sourceType 字段），
  // 直接以 clusterId 为选题身份（无 clusterId 的兜底 title）。R10.35 前按 title 聚
  // 不起同簇多行（标题各不同），与审查台 clu: 键同口径。
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());
  const groups = (() => {
    const byKey = new Map<string, any[]>();
    for (const o of pending) {
      const key = o.clusterId ? "clu:" + o.clusterId : "title:" + String(o.title || "").trim();
      const bucket = byKey.get(key);
      if (bucket) bucket.push(o);
      else byKey.set(key, [o]);
    }
    return [...byKey.entries()].map(([key, members]) => ({
      key,
      title: members[0].title.trim(),
      members,
      primary: members[0],
    }));
  })();
  async function decideGroup(group: { members: any[] }, decision: string, rejectReason?: string) {
    if (group.members.length === 1) return decide(group.members[0], decision, rejectReason);
    return ws.act(
      async () => {
        for (const m of group.members) await api("outlines/" + m.id + "/decision", { decision, ...(rejectReason ? { rejectReason } : {}) });
      },
      {
        apply: () => ws.mutateOutlines((list) => list.map((x) => (group.members.some((m) => m.id === x.id) ? { ...x, decision } : x))),
        undo: () => ws.mutateOutlines((list) => list.map((x) => (group.members.some((m) => m.id === x.id) ? { ...x, decision: "pending" } : x))),
      },
    );
  }
  const clusterOf = (o: any) => clusters.find((c) => c.id === o.clusterId);
  useListKeyboardShortcuts(".discovery-row", { approve: () => groups[0] && decideGroup(groups[0], "approved"), archive: () => groups[0] && decideGroup(groups[0], "rejected", "其他"), discuss: () => groups[0] && setDetail(groups[0].primary) }, groups.length > 0);

  // P2③ 乐观拍板：本地先移出待拍队列（<50ms），失败回滚并提示，成功后台 refresh 对账。
  function decide(o: any, decision: string, rejectReason?: string) {
    return ws.act(
      async () => { await api("outlines/" + o.id + "/decision", { decision, ...(rejectReason ? { rejectReason } : {}) }); },
      {
        apply: () => ws.mutateOutlines((list) => list.map((x) => (x.id === o.id ? { ...x, decision } : x))),
        undo: () => ws.mutateOutlines((list) => list.map((x) => (x.id === o.id ? { ...x, decision: "pending" } : x))),
      },
    );
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
          {groups.map((group) => {
            const o = group.primary;
            const dupCount = group.members.length;
            const cluster = clusterOf(o);
            return (
              <article className="discovery-row" key={o.id}>
                <div className="row-number">
                  {String(outlineScore(o).toFixed(1))}
                </div>
                <div className="row-content">
                  <div className="row-meta">
                    {dupCount > 1 && (
                      <button className="pill" style={{ cursor: "pointer" }} onClick={() => setOpenGroups((prev) => { const next = new Set(prev); if (next.has(group.key)) next.delete(group.key); else next.add(group.key); return next; })}>
                        同题 ×{dupCount}
                      </button>
                    )}
                    <span>{platformLabel(o.platform)}{o.category ? ` · ${categoryLabel(o.category)}` : ""}</span>
                    {o.draftBody && <span className="pill" style={{ color: "#1a7f4b", borderColor: "#1a7f4b" }}>有草稿</span>}
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
                    {(o.evidenceRefs || []).slice(0, 1).map((ref: string) => (
                      <a key={ref} href={ref} target="_blank" rel="noopener noreferrer">数据源 ↗</a>
                    ))}
                    {(o.evidenceRefs?.length || 0) > 1 && <span>+{o.evidenceRefs.length - 1}</span>}
                    {(o.evidenceRefs?.length || 0) > 3 && <span>+{o.evidenceRefs.length - 3}</span>}
                  </div>
                </div>
                <div className="row-side">
                  <small>{o.evidenceRefs?.length || 0} 条数据源</small>
                  {/* R10.8 P1-4：拍板口收敛到审查台（唯一拍板口），队列侧只读+跳转 */}
                  <div style={{ display: "flex", gap: 6 }}>
                    <button className="primary" onClick={() => navigate("decisions")}>去审查台拍板 ↗</button>
                  </div>
                  {reasonFor === o.id && (
                    <Select aria-label={o.title + " 否决原因"} placeholder="选否决原因…" onChange={(e) => { const v = e.target.value; if (v) { setReasonFor(null); void decideGroup(group, "rejected", v); } }} style={{ marginTop: 6 }}>
                      <option value="off-domain">超出领域</option>
                      <option value="no-ai-signal">没有 AI 信号</option>
                      <option value="已写过">已经写过</option>
                      <option value="写不透">写不透</option>
                      <option value="不感兴趣">不感兴趣</option>
                      <option value="其他">其他</option>
                    </Select>
                  )}
                </div>
                {dupCount > 1 && openGroups.has(group.key) && (
                  <div style={{ width: "100%", borderTop: "1px dashed var(--line)", paddingTop: 8, display: "grid", gap: 8 }}>
                    {group.members.map((m) => (
                      <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span className="card-meta" style={{ flex: 1 }}>{date(m.createdAt)} · {(m.evidenceRefs || []).length} 条数据源</span>
                        {m.decision === "pending" ? (
                          <span style={{ display: "flex", gap: 6 }}>
                            <button disabled={busy} onClick={() => void decide(m, "approved")}>通过</button>
                            <button disabled={busy} onClick={() => void decide(m, "rejected", "重复条目")}>否决</button>
                          </span>
                        ) : (
                          <span className="card-meta">{m.decision}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
      {detail && <OutlineDrawer outline={detail} cluster={clusterOf(detail)} onClose={() => setDetail(null)} onDecide={(d, rr) => decide(detail, d, rr)}
        onPlatformDecide={async (platform, decision) => { await ws.act(async () => { await api(`outlines/${detail.id}/platform-decision`, { platform, decision }); }); }}
        onCategory={async (category) => { await ws.act(async () => { await api(`outlines/${detail.id}/category`, { category }); }); }} />}
    </>
  );
}

export function OutlineDrawer({ outline: o, cluster, onClose, onDecide, onPlatformDecide, onCategory }: { outline: any; cluster: any; onClose: () => void; onDecide: (d: string, rr?: string) => Promise<void>; onPlatformDecide?: (platform: string, decision: string) => Promise<void>; onCategory?: (category: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const evidenceRefs = o.evidenceRefs || [];
  const statusLabel = ({pending:"待决策",approved:"已通过",drafting:"写作中",published:"已发布",rejected:"已否决",deferred:"已暂缓"} as Record<string,string>)[o.decision] || o.decision;
  const cycle: Record<string, string> = { pending: "approved", approved: "drafting", drafting: "published", published: "rejected", rejected: "deferred", deferred: "pending" };
  // R10.35：适合平台 = platforms（新数据）或 [platform]（存量单平台行），只渲染这些平台的拍板徽章
  const fitPlatforms = (o.platforms?.length ? o.platforms : [o.platform])
    .map((p: string) => PLATFORM_KEYS.find((k) => k === p || PLATFORM_LABELS[k] === p))
    .filter(Boolean) as string[];
  return (
    <Drawer
      title={o.title}
      subtitle={[fitPlatforms.map((k) => PLATFORM_LABELS[k]).join(" / ") || platformLabel(o.platform), o.category ? categoryLabel(o.category) : "", cluster ? cluster.topic : "选题收集箱", date(o.createdAt)].filter(Boolean).join(" · ")}
      onClose={onClose}
      wide
    >
      {/* 状态与拍板：收进一张状态卡，拍板键不再悬浮 */}
      <div className="drawer-status">
        <span className={"creation-badge " + (o.decision === "pending" ? "" : "ready")}>{statusLabel}</span>
        {/* 题材徽章（可点改：LLM 初标的人工纠偏口，第六轮批 B） */}
        {onCategory && (
          <button className="pill" style={{ cursor: "pointer" }} title="点击切换题材（LLM 初标可人工纠偏）"
            disabled={busy} onClick={() => {
              const current = CATEGORY_KEYS.indexOf(o.category) ;
              const next = CATEGORY_KEYS[(current + 1 + CATEGORY_KEYS.length) % CATEGORY_KEYS.length];
              void onCategory(next);
            }}>{categoryLabel(o.category) || "标题材"} ↻</button>
        )}
        {o.decision === "pending" ? (
          <div className="term-actions">
            <button className="primary" disabled={busy} onClick={() => void onDecide("approved").then(onClose)}>通过</button>
            <button disabled={busy} onClick={() => void onDecide("deferred").then(onClose)}>暂缓</button>
            <button disabled={busy} onClick={() => void onDecide("rejected", "其他").then(onClose)}>否决</button>
          </div>
        ) : (
          o.decision === "published" && o.publishedRef ? <a className="decision-meta" href={o.publishedRef} target="_blank" rel="noreferrer">{o.publishedRef}</a> : null
        )}
      </div>

      {/* 推荐建议（R10.35）：为什么这么写、投哪些平台、各平台怎么适配 */}
      {o.recommendation && (
        <section className="drawer-section">
          <h3>推荐建议</h3>
          <p style={{ margin: 0, lineHeight: 1.7 }}>{o.recommendation}</p>
        </section>
      )}

      {/* 适合平台（R10.35）：一条选题标注适合投哪些平台，不再每平台各写一份大纲 */}
      {fitPlatforms.length > 0 && (
        <section className="drawer-section">
          <h3>适合平台（{fitPlatforms.length}）</h3>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {fitPlatforms.map((k) => <span key={k} className="pill">{PLATFORM_LABELS[k]}</span>)}
          </div>
        </section>
      )}

      {/* 按平台拍板（第六轮批 B）：只列适合平台，点击循环状态——同题×N 互不连拍 */}
      {onPlatformDecide && fitPlatforms.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }} aria-label="按平台拍板">
          {fitPlatforms.map((k) => {
            const st = (o.perPlatformDecision?.[k] || (platformLabel(o.platform) === PLATFORM_LABELS[k] ? o.decision : "pending")) as string;
            const color = st === "approved" || st === "published" ? "#1a7f4b" : st === "drafting" ? "#8a6d1a" : st === "rejected" ? "#8a3a3a" : undefined;
            return (
              <button key={k} className="pill" style={{ cursor: "pointer", color, borderColor: color }}
                title={`点击拍板：${PLATFORM_LABELS[k]} → ${({pending:"待决策",approved:"已通过",drafting:"写作中",published:"已发布",rejected:"已否决",deferred:"已暂缓"} as Record<string,string>)[cycle[st]] || cycle[st]}`}
                disabled={busy}
                onClick={() => void onPlatformDecide(k, cycle[st] || "pending")}>
                {PLATFORM_LABELS[k]} · {({pending:"待决策",approved:"已通过",drafting:"写作中",published:"已发布",rejected:"已否决",deferred:"已暂缓"} as Record<string,string>)[st] || st}
              </button>
            );
          })}
        </div>
      )}

      {/* 内容结构（outline 数组）：每日发现与审查台共用渲染（第六轮批 B 补渲染位） */}
      {o.outline?.length ? (
        <section className="drawer-section">
          <h3>内容结构（{o.outline.length} 段）</h3>
          <ol className="drawer-points">{o.outline.map((k: string, i: number) => <li key={i}>{k}</li>)}</ol>
        </section>
      ) : null}

      {/* 写作要点 */}
      <section className="drawer-section">
        <h3>写作要点</h3>
        {o.keyPoints?.length ? (
          <ul className="drawer-points">{o.keyPoints.map((k: string, i: number) => <li key={i}>{k}</li>)}</ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>暂无写作要点——可在「研究讨论」里围绕这个选题补齐角度，或直接拍板进入选题库。</p>
        )}
      </section>

      {/* 数据源：空态给引导而非留白 */}
      <section className="drawer-section">
        <h3>数据源（{evidenceRefs.length}）</h3>
        {evidenceRefs.length ? (
          <ul className="drawer-sources">
            {evidenceRefs.map((ref: string) => (
              <li key={ref}>
                <a href={ref} target="_blank" rel="noopener noreferrer">{ref.length > 90 ? ref.slice(0, 90) + "…" : ref} ↗</a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            这个选题还没有登记原始出处。补证据的两条路：在「热点资讯」找到相关线索点「讨论」带入；
            或在讨论里让 AI 给出待核实的来源清单，逐条核对后再引用。
          </p>
        )}
      </section>

      {/* 外部建议 */}
      {!!o.suggestions?.length && (
        <section className="drawer-section">
          <h3>外部建议（{o.suggestions.length}）</h3>
          {o.suggestions.map((s: any, i: number) => (
            <div className="claim" key={i}>
              <span className="pill">{s.by}</span>
              <p>{s.verdict}{typeof s.score === "number" ? ` · 评分 ${s.score}` : ""}{s.reason ? ` · ${s.reason}` : ""}</p>
            </div>
          ))}
        </section>
      )}

      {/* 草稿正文（Markdown 渲染——贴图号图卡组/视频分镜是结构化内容；pending 有草稿同样可见） */}
      {o.draftBody && (
        <section className="drawer-section">
          <h3>草稿正文{o.decision === "pending" ? "（有草稿 · pending 只读）" : ""}</h3>
          <div className="draft-preview"><MessageContent text={o.draftBody} /></div>
        </section>
      )}
    </Drawer>
  );
}
