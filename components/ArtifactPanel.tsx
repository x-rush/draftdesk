"use client";
// 产物详情面板（PHASE 5 拆分后）：编辑器与详情渲染移至 ./artifact/，
// 此处 re-export ArtifactEditor 保持既有 import 面（Discussion.tsx 等）不变。
import { creationLabels } from "../core/workspace-ui";
import { Select } from "./Select";
import { ResearchHistory } from "./ResearchHistory";
import { EvidenceReadiness } from "./EvidenceReadiness";
import { decisionLabels, decisionOf } from "../core/research-policy";
import { useEffect, useState } from "react";
import type { Artifact, ArtifactDraft, Evidence } from "../core/schema";
import { Drawer, Field, api, kindLabels, date } from "./ui";
import { Details } from "./artifact/Details";
import { ArtifactEditor } from "./artifact/ArtifactEditor";
export { ArtifactEditor } from "./artifact/ArtifactEditor";
export { Details } from "./artifact/Details";
export function ArtifactPanel({
  artifact,
  onClose,
  onChange,
  onDiscuss, navigation,
}: {
  artifact: Artifact;
  onClose: () => void;
  onChange: () => Promise<void>;
  onDiscuss: (a: Artifact) => void;
  navigation?: import("react").ReactNode;
}) {
  const [evidence, setEvidence] = useState<Evidence[]>([]),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [publishing, setPublishing] = useState(false);
  useEffect(() => {
    let alive = true;
    void Promise.allSettled(
      artifact.evidenceIds.map((id) => api<Evidence>("evidence/" + id)),
    )
      .then((v) => {
        if (alive) {
          setEvidence(v.flatMap(r => r.status === 'fulfilled' ? [r.value] : []));
          if (v.some(r => r.status === 'rejected')) setError('部分证据不存在或读取失败，请查看质量提示并重新研究。');
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [artifact.id]);
  async function change(patch: object) {
    setBusy(true);
    try {
      await api("artifacts", {
        id: artifact.id,
        revision: artifact.revision,
        ...patch,
      });
      await onChange();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (editing)
    return (
      <ArtifactEditor
        initial={artifact}
        target={artifact}
        updateOnly
        onClose={() => setEditing(false)}
        onSave={async (d) => {
          await api("artifacts", {
            id: artifact.id,
            revision: artifact.revision,
            draft: strip(d),
          });
          await onChange();
          onClose();
        }}
      />
    );
  return (
    <Drawer
      title={artifact.title}
      subtitle={`${kindLabels[artifact.kind]} · ${artifact.visibility === "private" ? "仅自己可见" : "已公开"} · ${date(artifact.updatedAt)}`}
      onClose={onClose}
      wide
    >
      {navigation}
      <div className="detail-actions">
        <button className="primary" onClick={() => onDiscuss(artifact)}>
          带着证据讨论
        </button>
        <button
          disabled={busy}
          onClick={() => void change({ decision: artifact.decision === "approved" ? "pending" : "approved" })}
        >
          {artifact.decision === "approved" ? "移出选题库" : "加入选题库"}
        </button>
        <button onClick={() => setEditing(true)}>编辑</button>
      </div>
      <Field label="创作状态" hint="只记录你的创作进度；标记已发布不会发布文章或改变公开权限。选择状态后自动加入选题库。"><Select value={artifact.creationStatus || "inbox"} disabled={busy} onChange={e => void change({ creationStatus: e.target.value })}>{Object.entries(creationLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
      <p className="lead">{artifact.summary}</p>
      <div className="tags">
        {artifact.tags.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
      <div className={"quality " + artifact.quality}>
        <strong>
          {decisionLabels[decisionOf(artifact)]}
        </strong>
        <p>{artifact.reviewNote || "请结合来源和自己的测试作最终判断。"}</p>
        {artifact.issues.length > 0 && (
          <ul>
            {artifact.issues.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        )}
      </div>
      <section>
        <h3>为什么与你有关</h3>
        <p>{artifact.personalImpact}</p>
        <h3>为什么是现在</h3>
        <p>{artifact.whyNow}</p>
      </section>
      {evidence.length > 0 && <EvidenceReadiness key={artifact.id} artifact={artifact} evidence={evidence} />}
      <Details draft={artifact} />
      <ResearchHistory artifactId={artifact.id} />
      <section>
        <h3>陈述与证据</h3>
        {artifact.claims.map((c, i) => (
          <div className="claim" key={i}>
            <span className="pill">
              {c.type === "fact"
                ? "来源事实"
                : c.type === "inference"
                  ? "分析推断"
                  : "待验证假设"}
            </span>
            <p>{c.statement}</p>
            {c.quote && <blockquote>{c.quote}</blockquote>}
            <small>
              {c.evidenceIds
                .map((id) => evidence.find((e) => e.id === id)?.title || id)
                .join("；")}
            </small>
          </div>
        ))}
      </section>
      <section>
        <h3>原始来源 · {evidence.length}</h3>
        {evidence.map((e) => (
          <article className="evidence" key={e.id}>
            <a href={e.url} target="_blank" rel="noreferrer">
              {e.title} ↗
            </a>
            <small>
              {e.region} ·{" "}
              {e.contentLevel === "fulltext" ? "全文片段" : "摘要线索"} ·{" "}
              {e.publishedAt ? "发布 " + date(e.publishedAt) : "发布时间未知"}
            </small>
            <p>{e.excerpt || "来源只有标题，没有正文。"}</p>
            {e.metric && (
              <p className="metric">
                {e.metric.name}：{e.metric.value}（{e.metric.unit}，
                {e.metric.period}）
              </p>
            )}
            <small>
              采集于 {date(e.collectedAt)} · {e.acquisition ? `${e.acquisition.platform} · ${e.acquisition.method === "aggregator" ? "聚合补充" : "平台入口"}（${e.acquisition.provider}）${e.acquisition.observedAt ? " · 榜单更新 " + date(e.acquisition.observedAt) : ""}` : e.provenance}
            </small>
          </article>
        ))}
      </section>
      <section>
        <h3>还需要核实</h3>
        <ul>
          {artifact.unknowns.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ul>
        <h3>下一步</h3>
        <ol>
          {artifact.nextActions.map((v, i) => (
            <li key={i}>{v}</li>
          ))}
        </ol>
      </section>
      {["topic", "news"].includes(artifact.kind) && (
        <section className="publication">
          <h3>公开控制</h3>
          <p>只公开这一条资讯或选题，不包含私人讨论和应用方案。</p>
          {artifact.visibility === "public" ? (
            <button
              disabled={busy}
              onClick={() => void change({ visibility: "private" })}
            >
              撤回到私有
            </button>
          ) : publishing ? (
            <div>
              <p>确认后，此条标题、摘要与方案可通过公开接口读取。</p>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void change({ visibility: "public" })}
              >
                确认公开这一条
              </button>
              <button onClick={() => setPublishing(false)}>取消</button>
            </div>
          ) : (
            <button
              disabled={artifact.quality !== "ready"}
              onClick={() => setPublishing(true)}
            >
              公开这一条
            </button>
          )}
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Drawer>
  );
}
export function strip(a: ArtifactDraft): ArtifactDraft {
  const {
    id,
    kind,
    title,
    summary,
    audience,
    whyNow,
    personalImpact,
    tags,
    evidenceIds,
    claims,
    unknowns,
    nextActions,
    details,
  } = a;
  return {
    id,
    kind,
    title,
    summary,
    audience,
    whyNow,
    personalImpact,
    tags,
    evidenceIds,
    claims,
    unknowns,
    nextActions,
    details,
  } as ArtifactDraft;
}
