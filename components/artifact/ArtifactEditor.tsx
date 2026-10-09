"use client";
// 产物编辑器（PHASE 5 自 ArtifactPanel.tsx 纯移动拆出；JSX 与拆分前逐字一致）。
import { draftChanges } from "../../core/workspace-ui";
import { Select } from "../Select";
import { detailLabels, Details } from "./Details";
import { useEffect, useState } from "react";
import type { Artifact, ArtifactDraft } from "../../core/schema";
import { Drawer, Field } from "../ui";

export function ArtifactEditor({
  initial,
  onSave,
  onClose,
  target, updateOnly = false,
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
    } catch { }
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
          .filter(([k]) => draft.kind !== "activity")
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
        <details className="draft-preview" open><summary>保存前预览{replace ? "与更新差异" : ""}</summary><h3>{draft.title}</h3><p>{draft.summary}</p><Details draft={draft} />
          {replace && target && <section><h3>以下字段将更新</h3>{draftChanges(target, draft).length === 0 ? <p>内容没有变化。</p> : draftChanges(target, draft).map(k => <details key={k}><summary>{({ title: "标题", summary: "摘要", audience: "读者", details: "内容结构", tags: "标签", claims: "事实结论", evidenceIds: "引用证据", unknowns: "待核实", nextActions: "下一步", whyNow: "时效", personalImpact: "个人影响" } as Record<string, string>)[k] || k}</summary><strong>原内容</strong><pre>{JSON.stringify((target as any)[k], null, 2)}</pre><strong>更新后</strong><pre>{JSON.stringify((draft as any)[k], null, 2)}</pre></details>)}</section>}
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
