"use client";
// R10.4-②：初筛展示面——当日组视角（判级徽章+理由+成员来源）+ 归档区（none 组可查可恢复）。
// 数据走现成 API（GET /triage/groups 最新批、GET /triage/archive、POST /triage/restore）。
import { useEffect, useState } from "react";
import { api, date } from "./ui";

const ATT: Record<string, { label: string; cls: string }> = {
  strong: { label: "● 强", cls: "att-strong" },
  potential: { label: "◐ 潜力", cls: "att-potential" },
  none: { label: "○ 无", cls: "att-none" },
};

type Group = { id: string; title: string; attention: string; reason: string; memberUrls: string[]; sources: string[]; angles: { platform: string; angle: string }[]; appGap?: string };
type GroupsRes = { jobId: string; planName: string; at: string; shards: number; calls: number; tokens: number; groups: (Group & { members: { title: string; url: string; sourceName: string; status: string }[] })[] };
type ArchiveRes = { items: { jobId: string; day: string; at: string; groups: { id: string; title: string; reason: string; members: number }[] }[]; total: number };

export function TriagePanorama() {
  const [groups, setGroups] = useState<GroupsRes | null>(null);
  const [archive, setArchive] = useState<ArchiveRes | null>(null);
  const [status, setStatus] = useState<{ state: string; error?: string; engine?: string; note?: string } | null>(null);
  const [filter, setFilter] = useState<"" | "strong" | "potential" | "none">("");
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [groupsError, setGroupsError] = useState("");

  async function refreshAll() {
    try { setGroups(await api<GroupsRes>("triage/groups")); setGroupsError(""); }
    catch (e) { setGroups(null); setGroupsError((e as Error).message); }
    setArchive(await api<ArchiveRes>("triage/archive").catch(() => null));
    const sum = await api<any>("summary/today").catch(() => null);
    setStatus(sum?.collectAll?.triage ?? null);
  }
  useEffect(() => { void refreshAll(); const t = setInterval(() => void refreshAll(), 30000); return () => clearInterval(t); }, []);
  async function rerun() {
    setBusy(true);
    try { const r = await api<{ note: string }>("triage/generate", {}); setNotice(r.note); }
    catch (e) { setNotice("补跑请求失败：" + (e as Error).message); } finally { setBusy(false); }
  }

  // R10.7 P0-2：组卡动作——strong/potential 组一键出大纲（进每日发现待拍）或转机会卡
  async function toOutline(g: Group) {
    setBusy(true);
    try {
      const platform = g.angles[0]?.platform || "gzh";
      await api("outlines", {
        clusterId: "clu-inbox", platform, contentType: "组卡直出",
        title: (g.angles.find((a) => a.platform === platform)?.angle || g.title).slice(0, 120), // P1-2：标题用该平台角度（选题句），无角度回退组名
        keyPoints: [...g.angles.map((a) => `${a.platform}：${a.angle}`), ...(g.appGap ? [`应用缺口：${g.appGap}`] : [])].slice(0, 8),
        evidenceRefs: g.memberUrls.slice(0, 10),
      });
      setNotice(`已生成大纲《${g.title.slice(0, 30)}》(${platform})，进每日发现待拍`);
    } catch (e) { setNotice("生成大纲失败：" + (e as Error).message); } finally { setBusy(false); }
  }
  async function toOpportunity(jobId: string, g: Group) {
    setBusy(true);
    try {
      const r = await api<{ note: string }>("opportunities/from-group", { jobId, groupId: g.id });
      setNotice(`组「${g.title.slice(0, 24)}」转机会卡：${r.note}`);
    } catch (e) { setNotice("转卡失败：" + (e as Error).message); } finally { setBusy(false); }
  }

  async function restore(jobId: string, groupId: string) {
    setBusy(true);
    try {
      const r = await api<{ restored: number }>("triage/restore", { jobId, groupId });
      setNotice(r.restored ? `已恢复 ${r.restored} 条候选回观察池` : "无匹配归档（可能已恢复）");
      await refreshAll();
    } catch (e) { setNotice("恢复失败：" + (e as Error).message); } finally { setBusy(false); }
  }

  if (!groups && !archive?.items?.length && !groupsError) return null;
  const counts = groups ? { strong: groups.groups.filter((g) => g.attention === "strong").length, potential: groups.groups.filter((g) => g.attention === "potential").length, none: groups.groups.filter((g) => g.attention === "none").length } : null;
  const shown = groups ? (filter ? groups.groups.filter((g) => g.attention === filter) : groups.groups) : [];
  const STATUS_BADGE: Record<string, string> = { done: "✅ 语义处理完成", failed: "❌ 语义处理失败", pending: "⏳ 待语义处理" };

  return (
    <section className="lens-panel" aria-label="初筛组视角与归档">
      {notice && <p role="status" className="notice">{notice}</p>}
      {status && (
        <div className="toolbar" style={{ marginBottom: 8 }}>
          <span className="pill">{STATUS_BADGE[status.state] || status.state}</span>
          {status.state !== "done" && status.engine !== "external" && <button className="button-secondary" disabled={busy} onClick={() => void rerun()}>补跑初筛</button>}
          {status.state === "failed" && status.error && <small className="muted" title={status.error}>{String(status.error).slice(0, 60)}</small>}
          {status.state === "pending" && status.engine === "external" && <small className="muted">采集完成，语义处理中——外部 Agent 将于 02:00 执行全套处理（归组/判级/归档/选题大纲/机会方向）</small>}
        </div>
      )}
      {groupsError && !groups && (
        <p className="lens-note">今日批次还没有组视角：{groupsError}。{status?.engine === "external" ? "外部 Agent 将于 02:00 完成语义处理（归组+判级+归档+选题大纲+机会方向），无需手动触发。" : "内置初筛在采集后自动跑（失败自动补跑），也可点「补跑初筛」手动触发。"}</p>
      )}
      {groups && (
        <details className="fold-card" open>
          <summary><h2 style={{ display: "inline", margin: 0 }}>今日组视角</h2> · {groups.planName} · {date(groups.at)} · {groups.groups.length} 组（强 {counts!.strong} / 潜 {counts!.potential} / 无 {counts!.none}）· {groups.shards} 片 {groups.calls} 调用 {(groups.tokens / 1000).toFixed(0)}k tokens</summary>
          <div className="toolbar" style={{ marginBottom: 8 }}>
            {([["", "全部", groups.groups.length], ["strong", "强", counts!.strong], ["potential", "潜", counts!.potential], ["none", "无", counts!.none]] as const).map(([k, label, n]) => (
              <button key={k} className={filter === k ? "active" : "button-secondary"} onClick={() => setFilter(k as any)}>{label} {n}</button>
            ))}
            <span style={{ flex: 1 }} />
            <button className="button-secondary" onClick={() => void refreshAll()}>刷新</button>
          </div>
          <div className="lens-list">
            {shown
              .sort((a, b) => (a.attention === "strong" ? -1 : 1) - (b.attention === "strong" ? -1 : 1) || b.members.length - a.members.length)
              .map((g) => (
                <article key={g.id}>
                  <div>
                    <span>{g.sources.slice(0, 3).join(" · ")}{g.sources.length > 3 ? ` +${g.sources.length - 3}` : ""}</span>
                    {ATT[g.attention] && <small className={`lens-attention ${ATT[g.attention].cls}`}>{ATT[g.attention].label}</small>}
                    <small>{g.members.length} 条 · {g.reason}</small>
                    {g.angles.length > 0 && <small>角度：{g.angles.map((a) => `${a.platform}:${a.angle}`).join("；")}</small>}
                    {g.appGap && <small>app 缺口：{g.appGap}</small>}
                  </div>
                  <button className="text-button" style={{ fontSize: 14, fontWeight: 600 }} onClick={() => setOpen(open === g.id ? null : g.id)}>{g.title}（点开成员）</button>
                  {g.attention !== "none" && (
                    <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                      <button className="button-secondary" disabled={busy} onClick={() => void toOutline(g)}>生成大纲</button>
                      <button className="button-secondary" disabled={busy} onClick={() => void toOpportunity(groups!.jobId, g)}>转机会卡</button>
                    </div>
                  )}
                  {open === g.id && (
                    <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
                      {g.members.map((m) => (
                        <li key={m.url}><a href={m.url} target="_blank" rel="noreferrer">{m.title} ↗</a> <small>{m.sourceName} · {m.status === "filtered" ? "已归档" : m.status === "selected" ? "已入选" : "留池"}</small></li>
                      ))}
                    </ul>
                  )}
                </article>
              ))}
          </div>
        </details>
      )}
      {archive && archive.items.length > 0 && (
        <details className="fold-card">
          <summary><h2 style={{ display: "inline", margin: 0 }}>归档区</h2> · 判「无注意力」的组（可查可恢复）· 共 {archive.total} 批</summary>
          {archive.items.slice(0, 7).map((a) => (
            <div key={a.jobId} style={{ margin: "8px 0" }}>
              <small>{a.day} · {a.groups.length} 组</small>
              <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13 }}>
                {a.groups.map((g) => (
                  <li key={g.id} style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <span>○ {g.title} <small>{g.members} 条 · {g.reason}</small></span>
                    <button className="text-button" disabled={busy} onClick={() => void restore(a.jobId, g.id)}>恢复</button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
