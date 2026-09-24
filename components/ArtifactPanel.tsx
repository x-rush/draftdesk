"use client";
import { creationLabels, draftChanges } from "../core/workspace-ui";
import { ActivityCard } from "./Activities";
import { Select } from "./Select";
import { ResearchHistory } from "./ResearchHistory";
import { EvidenceReadiness } from "./EvidenceReadiness";
import { decisionLabels, decisionOf } from "../core/research-policy";
import { useEffect, useState } from "react";
import type { Artifact, ArtifactDraft, Evidence } from "../core/schema";
import { Drawer, Field, api, kindLabels, date } from "./ui";
const detailLabels: Record<string, string> = {
  whatChanged: "发生了什么变化",
  availability: "可用性与门槛",
  limitations: "限制",
  angle: "原创角度",
  readerPromise: "读者能获得什么",
  outline: "创作提纲",
  materialChecklist: "素材准备",
  keyword: "关键词",
  region: "适用地域",
  window: "观察窗口",
  intent: "搜索意图",
  comparison: "同口径对比",
  opportunity: "可行动机会",
  cautions: "口径与偏差",
  job: "用户要完成的任务",
  trigger: "触发场景",
  frequency: "发生频率",
  alternatives: "现有替代",
  differentiation: "与替代方案的差异",
  mvp: "最小产品流程",
  nonGoals: "暂不做什么",
  willingnessToPay: "付费证据或假设",
  experiment: "验证实验",
  successCriteria: "成功条件",
  stopCriteria: "停止条件",
  name: "公开姓名／账号",
  identity: "身份与归属",
  publicChannels: "公开渠道",
  recentWork: "近期作品",
  angles: "值得研究的角度",
  identityCaveat: "身份核对限制",
};
export function Details({ draft }: { draft: ArtifactDraft }) {
  if(draft.kind==="activity")return <ActivityCard activity={draft}/>;
  return (
    <div className="detail-sections">
      {Object.entries(draft.details)
        .filter(([k]) => !["platforms", "signalEvidenceIds"].includes(k))
        .map(([key, value]) => (
          <section key={key}>
            <h3>{detailLabels[key] || key}</h3>
            {Array.isArray(value) ? (
              <ol>
                {value.map((s, i) => (
                  <li key={i}>{String(s)}</li>
                ))}
              </ol>
            ) : (
              <p>{String(value)}</p>
            )}
          </section>
        ))}
      {draft.kind === "topic" &&
        draft.details.platforms.map((p) => (
          <section className="platform-variant" key={p.name}>
            <h3>{p.name}版本</h3>
            <ul>
              {p.titles.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
            <p>{p.hook}</p>
            <ol>
              {p.structure.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </section>
        ))}
    </div>
  );
}
export function ArtifactEditor({
  initial,
  onSave,
  onClose,
  target, updateOnly=false,
}: {
  initial: ArtifactDraft;
  onSave: (d: ArtifactDraft, updateOriginal?: boolean) => Promise<void>;
  onClose: () => void;
  target?: Artifact;
  updateOnly?: boolean;
}) {
  const cacheKey =
    "draftdesk.edit.v2." + (initial.id || initial.kind + ":" + initial.title);
  const [draft, setDraft] = useState<ArtifactDraft>(() => {
      try {
        const value = JSON.parse(localStorage.getItem(cacheKey) || "null");
        if (
          value?.kind === initial.kind &&
          value?.details &&
          Array.isArray(value.claims) &&
          Array.isArray(value.evidenceIds)
        )
          return value;
      } catch {}
      return initial;
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [replace, setReplace] = useState(updateOnly);
  useEffect(() => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(draft));
    } catch {
      setError("编辑草稿未能保存在浏览器，请复制重要内容。");
    }
  }, [draft, cacheKey]);
  const update = (key: string, value: unknown) =>
    setDraft({ ...draft, [key]: value } as ArtifactDraft);
  return (
    <Drawer
      title="编辑研究产物"
      subtitle="编辑草稿保存在此浏览器。保存为私有待审内容，不代表事实已核实。"
      onClose={() => {
        if (!busy) onClose();
      }}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            await onSave(draft, replace);
            localStorage.removeItem(cacheKey);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {!updateOnly && target?.kind === draft.kind && (
          <Field label="保存方式">
            <Select
              value={replace ? "update" : "new"}
              onChange={(e) => setReplace(e.target.value === "update")}
            >
              <option value="new">保存为新内容</option>
              <option value="update">更新原内容：{target.title}</option>
            </Select>
          </Field>
        )}
        <Field label="标题">
          <input
            required
            maxLength={120}
            value={draft.title}
            onChange={(e) => update("title", e.target.value)}
          />
        </Field>
        {(
          [
            ["summary", "核心摘要"],
            ["audience", "目标读者"],
            ["whyNow", "为什么是现在"],
            ["personalImpact", "与个人任务的关系"],
          ] as const
        ).map(([key, label]) => (
          <Field key={key} label={label}>
            <textarea
              required
              value={draft[key]}
              onChange={(e) => update(key, e.target.value)}
              rows={key === "summary" ? 4 : 2}
            />
          </Field>
        ))}
        <Field label="多个标签（逗号分隔）">
          <input
            defaultValue={draft.tags.join("，")}
            onChange={(e) =>
              update(
                "tags",
                e.target.value
                  .split(/[,，]/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
        </Field>
        {Object.entries(draft.details)
          .filter(([k]) => draft.kind!=="activity")
          .filter(([k]) => !["platforms", "signalEvidenceIds"].includes(k))
          .map(([key, value]) => (
            <Field label={detailLabels[key] || key} key={key}>
              <textarea
                rows={3}
                value={Array.isArray(value) ? value.join("\n") : String(value)}
                onChange={(e) =>
                  update("details", {
                    ...draft.details,
                    [key]: Array.isArray(value)
                      ? e.target.value.split("\n").filter(Boolean)
                      : e.target.value,
                  })
                }
              />
            </Field>
          ))}
        {draft.kind === "topic" &&
          draft.details.platforms.map((p, index) => (
            <fieldset key={index}>
              <legend>{p.name}版本</legend>
              <Field label="标题备选（每行一个）">
                <textarea
                  value={p.titles.join("\n")}
                  onChange={(e) =>
                    update("details", {
                      ...draft.details,
                      platforms: draft.details.platforms.map((x, i) =>
                        i === index
                          ? {
                              ...x,
                              titles: e.target.value
                                .split("\n")
                                .filter(Boolean),
                            }
                          : x,
                      ),
                    })
                  }
                />
              </Field>
              <Field label="开头切入">
                <textarea
                  value={p.hook}
                  onChange={(e) =>
                    update("details", {
                      ...draft.details,
                      platforms: draft.details.platforms.map((x, i) =>
                        i === index ? { ...x, hook: e.target.value } : x,
                      ),
                    })
                  }
                />
              </Field>
              <Field label="结构／逐页内容（每行一项）">
                <textarea
                  value={p.structure.join("\n")}
                  onChange={(e) =>
                    update("details", {
                      ...draft.details,
                      platforms: draft.details.platforms.map((x, i) =>
                        i === index
                          ? {
                              ...x,
                              structure: e.target.value
                                .split("\n")
                                .filter(Boolean),
                            }
                          : x,
                      ),
                    })
                  }
                />
              </Field>
            </fieldset>
          ))}
        {(["unknowns", "nextActions"] as const).map((key) => (
          <Field
            label={
              key === "unknowns" ? "仍待核实（每行一项）" : "下一步（每行一项）"
            }
            key={key}
          >
            <textarea
              value={draft[key].join("\n")}
              onChange={(e) =>
                update(key, e.target.value.split("\n").filter(Boolean))
              }
            />
          </Field>
        ))}
        <p className="muted">
          证据引用和平台版本随草稿保留；涉及事实改变时请重新研究。
        </p>
        <details className="draft-preview" open><summary>保存前预览{replace?"与更新差异":""}</summary><h3>{draft.title}</h3><p>{draft.summary}</p><Details draft={draft}/>
          {replace&&target&&<section><h3>以下字段将更新</h3>{draftChanges(target,draft).length===0?<p>内容没有变化。</p>:draftChanges(target,draft).map(k=><details key={k}><summary>{({title:"标题",summary:"摘要",audience:"读者",details:"内容结构",tags:"标签",claims:"事实结论",evidenceIds:"引用证据",unknowns:"待核实",nextActions:"下一步",whyNow:"时效",personalImpact:"个人影响"} as Record<string,string>)[k] || k}</summary><strong>原内容</strong><pre>{JSON.stringify((target as any)[k],null,2)}</pre><strong>更新后</strong><pre>{JSON.stringify((draft as any)[k],null,2)}</pre></details>)}</section>}
        </details>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <footer className="form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "保存中…" : "保存草稿"}
          </button>
        </footer>
      </form>
    </Drawer>
  );
}
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
          setEvidence(v.flatMap(r=>r.status==='fulfilled'?[r.value]:[]));
          if(v.some(r=>r.status==='rejected'))setError('部分证据不存在或读取失败，请查看质量提示并重新研究。');
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
          onClick={() => void change({ saved: !artifact.saved })}
        >
          {artifact.saved ? "取消收藏" : "加入选题库"}
        </button>
        <button onClick={() => setEditing(true)}>编辑</button>
      </div>
      <Field label="创作状态" hint="只记录你的创作进度；标记已发布不会发布文章或改变公开权限。选择状态后自动加入选题库。"><Select value={artifact.creationStatus || "inbox"} disabled={busy} onChange={e=>void change({creationStatus:e.target.value})}>{Object.entries(creationLabels).map(([k,v])=><option key={k} value={k}>{v}</option>)}</Select></Field>
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
              采集于 {date(e.collectedAt)} · {e.acquisition ? `${e.acquisition.platform} · ${e.acquisition.method==="aggregator"?"聚合补充":"平台入口"}（${e.acquisition.provider}）${e.acquisition.observedAt?" · 榜单更新 "+date(e.acquisition.observedAt):""}` : e.provenance}
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
