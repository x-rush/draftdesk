"use client";
import { useState } from "react";
import { evidenceReadiness } from "../core/readiness";
import type { ArtifactDraft, Evidence } from "../core/schema";

export function EvidenceReadiness({artifact,evidence}:{artifact:ArtifactDraft;evidence:Evidence[]}) {
  const [notice,setNotice] = useState("");
  const checks = evidenceReadiness(artifact,evidence);
  return <section className="readiness-panel">
    <h3>证据缺口与下一步</h3>
    <p className="muted">这是材料检查，不是事实认证。找到候选材料后，仍需核对原话、上下文与结论的关系。</p>
    {checks.map(c=><article key={c.key} className={"readiness-check " + c.status}>
      <header><strong>{c.label}</strong><span className="pill">{c.status==="candidate"?"有候选材料 · 待核对":"缺少材料"}</span></header>
      <p>{c.reason}</p>
      {c.status === "candidate" && <ul>{c.evidenceIds.map(id=>{const e=evidence.find(e=>e.id===id);return e ? <li key={id}><a href={e.url} target="_blank" rel="noreferrer">{e.title} ↗</a></li>:null})}</ul>}
      <p><strong>建议行动：</strong>{c.action}</p>
      <button onClick={async()=>{try{await navigator.clipboard.writeText(c.query);setNotice(`已复制“${c.label}”补查词，不会自动启动搜索或模型。`)}catch{setNotice("复制失败，请手动选取下方补查词。")}}}>复制补查词</button>
      <p className="muted">{c.query}</p>
    </article>)}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
