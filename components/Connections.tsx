"use client";
import { Select } from "./Select";
import { formatApiError } from "./ui";
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
  config: any;
  sources: Source[]; jobs: Job[]; artifacts: Artifact[]; onOpen:(a:Artifact)=>void;
}) {
  const [name, setName] = useState("Hermes 研究助手"),
    [token, setToken] = useState(""),
    [readScope, setReadScope] = useState(false),
    [consumeScope, setConsumeScope] = useState(false),
    [suggestScope, setSuggestScope] = useState(false),
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
      setError(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-split">
      <div className="split-main">
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <AgentSetup plan={plans.find(p=>p.id===plan)} sources={sources}/>
      <section className="surface">
        <h2>接入令牌</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              const scopes = [readScope && "read", consumeScope && "consume", suggestScope && "suggest"].filter(Boolean);
              const r = await api("connections", { name, scopes: scopes.length ? scopes : undefined });
              setToken(r.token);
              {
        const caps = ["提交回传", ...((r.scopes || []).includes("read") ? ["只读"] : []), ...((r.scopes || []).includes("consume") ? ["消费"] : []), ...((r.scopes || []).includes("suggest") ? ["建议写回"] : [])];
        setNotice("令牌已创建（能力：" + caps.join(" + ") + "），仅在这次显示。提交回传为默认能力，无需勾选。");
      }
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
          <label className="check">
            <input
              type="checkbox"
              checked={readScope}
              onChange={(e) => setReadScope(e.target.checked)}
            />
            只读访问（agent API / MCP 读取搜罗数据）
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={consumeScope}
              onChange={(e) => setConsumeScope(e.target.checked)}
            />
            消费标记（批量把已处理的热榜/证据置为已消费，可撤销）
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={suggestScope}
              onChange={(e) => setSuggestScope(e.target.checked)}
            />
            建议写回（写 clusters / outlines / suggestions；不能拍板 decision）
          </label>
          <button className="primary" disabled={busy}>
            创建令牌
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
        {connections.filter((c: any) => !c.revoked).map((c: any) => (
          <div className="token-row" key={c.id}>
            <span className="token-name">{c.name}</span>
            <span className="token-scopes">{(c.scopes || ["submit"]).filter((sc: string) => sc !== "submit").map((sc: string) => ({ read: "读取", consume: "消费", suggest: "建议写回" } as Record<string, string>)[sc] || sc).join(" + ") || "仅提交"}</span>
            <span className="token-scopes">{c.lastUsedAt ? "最近使用 " + date(c.lastUsedAt) : "尚未使用"}</span>
            <span className="card-actions">
              <button disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await api("revoke", { id: c.id });
                    setNotice("连接令牌已撤销。");
                  })
                }
              >撤销</button>
            </span>
          </div>
        ))}
        {connections.some((c: any) => c.revoked) && (
          <details className="token-group">
            <summary>已撤销 / 历史（{connections.filter((c: any) => c.revoked).length}）</summary>
            {connections.filter((c: any) => c.revoked).map((c: any) => (
              <div className="token-row" key={c.id}>
                <span className="token-name">{c.name}</span>
                <span className="token-scopes">{c.revokedAt ? "撤销于 " + date(c.revokedAt) : "已撤销"}</span>
              </div>
            ))}
          </details>
        )}
      </section>
      <section className="surface">
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
      <section className="surface">
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
      </div>
      <aside className="split-side">
        <section className="surface">
          <h2>两条研究路径</h2>
          <p className="helper-text">二选一，随时切换：<strong>内置管线</strong>零额外组件；<strong>外部回传</strong>适合已有个人助理 Agent 的用户。</p>
          {plans.find(p=>p.id===plan)?.scheduleEnabled&&<p role="status" className="notice">
            所选策略「{plans.find(p=>p.id===plan)?.name}」的内置每日定时仍在启用。两条路径同时在跑会重复消耗模型额度；要改用外部回传，请到「研究策略」关闭「每天自动运行」。
          </p>}
          <details>
            <summary>路径说明与接入步骤</summary>
            <p className="helper-text">内置管线是默认路径，在「研究策略」打开「每天自动运行」即可。外部回传：关掉内置定时，让 Agent 按导出的策略自主搜罗、整理，并在自己的调度里定时回传统一证据包，替代内置管线。接收后先待审，需要时再交给内置研究流程。</p>
            <ol className="setup-steps">
              <li>下载 Skill 包，交给你的智能体安装。</li>
              <li>创建令牌（勾选读取/消费可让 Agent 读取并标记搜罗数据），通过环境变量配置地址和令牌。</li>
              <li>让智能体按协议提交，检查左侧收件回执。</li>
            </ol>
            <p className="helper-text">分步操作、各运行器 MCP 配置示例与排障见 <a href="https://github.com/x-rush/draftdesk/blob/main/docs/agent-integration.md" target="_blank" rel="noreferrer">外部 Agent 接入指南</a>。</p>
          </details>
          <Field label="交给外部工具的研究策略">
            <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="card-actions" style={{ justifyContent: "flex-start" }}>
            <a className="button button-secondary" href="/api/v1/skill-bundle" download>Skills 与提交脚本</a>
            <button onClick={() => void act(async () => download("draftdesk-intake.schema.json", await api("schema")))}>JSON Schema</button>
            <button onClick={() => void act(async () => download("draftdesk-plan.json", plans.find((p) => p.id === plan)))}>导出策略</button>
          </div>
          <p className="helper-text">模型密钥不交给外部工具。外部收件不会自动产生付费分析，也不会自动公开。跨机器访问需要另行配置安全网络入口。</p>
        </section>
      </aside>
    </div>
  );
}
