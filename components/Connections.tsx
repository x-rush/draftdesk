"use client";
import { Select } from "./Select";
import { useState } from "react";
import type { Plan, Source, Job, Artifact } from "../core/schema";
import { AgentSetup } from "./AgentSetup";
import { ResearchBrief } from "./ResearchBrief";
import { api, download, Field, date } from "./ui";
export function Connections({
  connections,
  receipts, pagination,
  plans,
  onChange,
  sources, jobs, artifacts, onOpen,
}: {
  connections: any[];
  receipts: any[];
  pagination?: import("react").ReactNode;
  plans: Plan[];
  onChange: () => Promise<void>;
  sources: Source[]; jobs: Job[]; artifacts: Artifact[]; onOpen:(a:Artifact)=>void;
}) {
  const [name, setName] = useState("Hermes 研究助手"),
    [token, setToken] = useState(""),
    [payload, setPayload] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [plan, setPlan] = useState(plans[0]?.id || "");
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
      await onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="connection-layout">
      <AgentSetup plan={plans.find(p=>p.id===plan)} sources={sources}/>
      <section className="surface">
        <h2>让外部研究进入同一个工作台</h2>
        <p>
          OpenClaw、Hermes
          或你自己的脚本，提交统一证据包。接收后先待审，需要时再交给内置研究流程。
        </p>
        <ol className="setup-steps">
          <li>下载 Skill 包，交给你的智能体安装。</li>
          <li>创建只具备提交权限的令牌，通过环境变量配置地址和令牌。</li>
          <li>让智能体按协议提交，检查下方收件回执。</li>
        </ol>
        <div className="toolbar">

          <a className="button" href="/api/v1/skill-bundle" download>
            下载 Skills 与提交脚本
          </a>
          <button
            onClick={() =>
              void act(async () =>
                download("draftdesk-intake.schema.json", await api("schema")),
              )
            }
          >
            下载 JSON Schema
          </button>
          <button
            onClick={() =>
              void act(async () =>
                download(
                  "draftdesk-plan.json",
                  plans.find((p) => p.id === plan),
                ),
              )
            }
          >
            导出所选策略
          </button>
        </div>
        <Field label="交给外部工具的研究策略">
          <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>

        <p className="muted">
          模型密钥不交给外部工具。外部收件不会自动产生付费分析，也不会自动公开。跨机器访问需要另行配置安全网络入口。
        </p>
      </section>
      <section className="surface">
        <h2>接入令牌</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const r = await api("connections", { name });
              setToken(r.token);
              setNotice("令牌已创建，仅在这次显示。");
            });
          }}
        >
          <Field label="连接名称">
            <input
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <button className="primary" disabled={busy}>
            创建提交令牌
          </button>
        </form>
        {token && (
          <div className="secret-box">
            <strong>复制并保管，不要放进公开仓库</strong>
            <input aria-label="新提交令牌" readOnly value={token} />
            <button onClick={() => void navigator.clipboard.writeText(token)}>
              复制令牌
            </button>
            <button onClick={() => setToken("")}>我已保存，隐藏</button>
          </div>
        )}
        {connections.map((c) => (
          <div className="connection-row" key={c.id}>
            <div>
              <strong>{c.name}</strong>
              <small>
                {c.revoked
                  ? "已撤销"
                  : c.lastUsedAt
                    ? "最近提交 " + date(c.lastUsedAt)
                    : "尚未使用"}
              </small>
            </div>
            <button
              disabled={busy || c.revoked}
              onClick={() =>
                void act(async () => {
                  await api("revoke", { id: c.id });
                  setNotice("连接令牌已撤销。");
                })
              }
            >
              撤销
            </button>
          </div>
        ))}
      </section>
      <section className="surface span-all">
        <h2>手动导入证据包</h2>
        <p>也可以直接粘贴符合协议的 JSON，不需要创建令牌。</p>
        <textarea
          aria-label="证据包 JSON"
          rows={7}
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          placeholder={
            '{"schemaVersion":"1.0","submissionId":"...","producer":{...},"evidence":[...],"drafts":[]}'
          }
        />
        <div className="toolbar">
          <button disabled={busy || !payload.trim()} onClick={()=>void act(async()=>{
            const r=await api("validate-intake",JSON.parse(payload));
            setNotice(r.ok?`格式与引用通过：${r.evidenceCount} 条证据、${r.draftCount} 条草稿；未入库，未验证搜索工具或事实。`:r.errors.map((e:any)=>`${e.path}：${e.message}`).join("；"));
          })}>只预检，不入库</button>
          <label className="button">
            选择 JSON 文件
            <input
              className="visually-hidden"
              type="file"
              accept="application/json,.json"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  if (file.size > 1000000) {
                    setError("文件超过 1 MB");
                    return;
                  }
                  void file.text().then(setPayload);
                }
              }}
            />
          </label>
          <button
            className="primary"
            disabled={busy || !payload.trim()}
            onClick={() =>
              void act(async () => {
                const r = await api("import", JSON.parse(payload));
                setNotice(
                  r.duplicate
                    ? "这批数据已接收，无重复写入。"
                    : "证据包已接收，等待分析。",
                );
                setPayload("");
              })
            }
          >
            验证并导入
          </button>
        </div>
      </section>
      <section className="surface span-all">
        <h2>收件箱</h2>
        {!receipts.length && (
          <p className="muted">
            还没有外部提交。收到证据包后，会在这里显示来源、数量与回执。
          </p>
        )}
        {receipts.map((r) => {
          const linked:Job[]=r.jobs || jobs.filter(j=>j.receiptId===r.id || (!j.receiptId && j.external && j.evidenceIds.length===r.evidenceIds.length && j.evidenceIds.every(id=>r.evidenceIds.includes(id))));
          const latest=linked[0];
          const selectedJob=linked.find(j=>j.planId===plan);
          const results:Artifact[]=r.artifacts || artifacts.filter(a=>r.artifactIds?.includes(a.id)||linked.some(j=>j.id===a.jobId));
          return (
          <div className="receipt" key={r.id}>
            <div>
              <strong>{r.producer}</strong>
              <p>{r.submissionId}</p>
              <small>
                {date(r.receivedAt)} · {r.evidenceIds.length} 条证据 · {latest?({queued:"已创建任务",running:"分析中",completed:latest.outcome==="no-findings"?"完成 · 无新增推荐":"分析完成",failed:"分析失败",cancelled:"已取消"}[latest.state]):r.artifactIds?.length?"已接收草稿 · 待核验":"已接收 · 未分析"}
              </small>
              {latest&&<p>{latest.stage}{latest.error?`：${latest.error}`:""}</p>}
              {latest&&<ResearchBrief job={latest}/>}
              {results.map(a=><button key={a.id} onClick={()=>onOpen(a)}>{a.title} · 查看结果</button>)}
              {latest&&<button onClick={()=>void act(async()=>download(`${latest.id}-research.json`,await api("job-context/"+latest.id)))}>查看研究说明（下载）</button>}
            </div>
            <button
              disabled={busy || !plan || !!selectedJob && ["queued","running","completed"].includes(selectedJob.state)}
              onClick={() =>
                void act(async () => {
                  await api("jobs", {
                    planId: plan,
                    evidenceIds: r.evidenceIds,
                    receiptId:r.id,
                    retry:!!selectedJob && ["failed","cancelled"].includes(selectedJob.state),
                  });
                  setNotice("已使用所选策略创建分析任务，可在运行记录查看。");
                })
              }
            >
              {selectedJob?.state==="completed"?"此策略已完成":selectedJob&&["queued","running"].includes(selectedJob.state)?"此策略处理中":selectedJob?"重试失败任务":"用所选策略分析（模型计费）"}
            </button>
          </div>
        );})}
        {pagination}
      </section>
      {error && (
        <p className="error span-all" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice span-all" role="status">
          {notice}
        </p>
      )}
    </div>
  );
}
