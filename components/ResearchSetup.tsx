"use client";
import { Select } from "./Select";
import { TimePicker } from "./TimePicker";
import { searchIntents } from "../core/research-policy";
import { useState } from "react";
import type { Plan, Source } from "../core/schema";
import { Drawer, Field, api, download, kindPlanLabels } from "./ui";
export function PlanEditor({
  initial,
  sources,
  onClose,
  onSaved,
}: {
  initial: Plan;
  sources: Source[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [p, setP] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const update = (key: string, v: unknown) => setP({ ...p, [key]: v });
  return (
    <Drawer
      title="研究策略"
      subtitle="指定目标、证据范围与预算，按北京时间运行。"
      onClose={onClose}
      wide
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("plans", p);
            await onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="策略名称">
          <input
            required
            value={p.name}
            onChange={(e) => update("name", e.target.value)}
          />
        </Field>
        <Field label="研究方向">
          <Select
            value={p.kind}
            onChange={(e) => update("kind", e.target.value)}
          >
            {Object.entries(kindPlanLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <p className="muted">本方向优先查找：{searchIntents[p.kind].join("；")}。没有合适证据时允许零推荐。</p>
        {p.kind === "trends" && <label className="check"><input type="checkbox" checked={!!p.requireMetrics} onChange={e=>update("requireMetrics",e.target.checked)} />只分析带原始指标的热词；无指标时保留线索，不调用模型凑结果。</label>}
        <Field label="希望解决的问题">
          <textarea
            required
            rows={4}
            value={p.goal}
            onChange={(e) => update("goal", e.target.value)}
          />
        </Field>
        <Field label="目标读者／用户">
          <input
            required
            value={p.audience}
            onChange={(e) => update("audience", e.target.value)}
          />
        </Field>
        {p.kind!=="activities"?<fieldset>
          <legend>选择搜索源</legend>
          {sources.map((s) => (
            <label className="check" key={s.id}>
              <input
                type="checkbox"
                checked={p.sourceIds.includes(s.id)}
                onChange={(e) =>
                  update(
                    "sourceIds",
                    e.target.checked
                      ? [...p.sourceIds, s.id]
                      : p.sourceIds.filter((id) => id !== s.id),
                  )
                }
              />
              <span>
                {s.name}
                {!s.enabled ? "（来源已停用）" : ""}
              </span>
            </label>
          ))}
        </fieldset>:<p className="muted">创作活动由浏览器扩展读取官方活动页，再导入证据；此处的网页来源配置不用于活动采集。</p>}
        <Field
          label="关键词／搜索问题（每行一项）"
          hint="网页搜索会结合研究方向扩展关键词，并在总次数内预留最多 2 次定向补证；趋势来源仍用原词过滤。"
        >
          <textarea
            rows={4}
            value={p.keywords.join("\n")}
            onChange={(e) =>
              update("keywords", e.target.value.split("\n").filter(Boolean))
            }
          />
        </Field>
        <Field label="内容筛选词（每行一项，可留空）" hint="所有来源的标题或正文至少命中一项才保留。请用短词和中英文别名；这与提交给搜索引擎的问题分开。">
          <textarea rows={4} value={(p.focusTerms || []).join("\n")} onChange={e=>update("focusTerms",e.target.value.split("\n").map(s=>s.trim()).filter(Boolean))} />
        </Field>
        <Field label="排除关键词（每行一项）">
          <textarea
            value={p.excludeKeywords.join("\n")}
            onChange={(e) =>
              update(
                "excludeKeywords",
                e.target.value.split("\n").filter(Boolean),
              )
            }
          />
        </Field>
        <Field label="限定域名（每行一项，可留空）">
          <textarea
            placeholder="例如 docs.example.com"
            value={p.includeDomains.join("\n")}
            onChange={(e) =>
              update(
                "includeDomains",
                e.target.value.split("\n").filter(Boolean),
              )
            }
          />
        </Field>
        <div className="form-grid">
          {(
            [
              ["lookbackDays", "回看天数", 1, 365],
              ["maxQueries", "最多网页搜索次数", 0, 8],
              ["maxEvidence", "最多候选证据", 3, 60],
              ["maxItems", "最多研究产物", 1, 8],
              ["maxModelCalls", "最多模型调用（含修复）", 3, 6],
              ["maxTokens", "单任务 token 预留上限", 30000, 200000],
            ] as const
          ).map(([key, label, min, max]) => (
            <Field label={label} key={key}>
              <input
                type="number"
                min={min}
                max={max}
                required
                value={p[key]}
                onChange={(e) => update(key, Number(e.target.value))}
              />
            </Field>
          ))}
        </div>
        {p.kind!=="activities"&&<><label className="check">
          <input
            type="checkbox"
            role="switch"
            checked={p.scheduleEnabled}
            onChange={(e) => update("scheduleEnabled", e.target.checked)}
          />
          每天自动运行
        </label>
        <Field label="北京时间">
          <TimePicker
            value={p.dailyTime}
            onChange={(value) => update("dailyTime", value)}
          />
        </Field>
        <p className="muted">
          电脑与 Worker
          需要保持运行。错过时间后仅补当天一次；失败不自动重复付费。所有结果先私有，公开需另行确认。
        </p></>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer className="form-actions">
          <button
            type="button"
            onClick={() => download(p.id + "-plan.json", p)}
          >
            导出策略
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "保存中…" : "保存策略"}
          </button>
        </footer>
      </form>
    </Drawer>
  );
}
export function SourceEditor({
  initial,
  onClose,
  onSaved,
}: {
  initial: Source;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [s, setS] = useState(initial),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Drawer title="配置数据源" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api("sources", s);
            await onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="名称">
          <input
            required
            value={s.name}
            onChange={(e) => setS({ ...s, name: e.target.value })}
          />
        </Field>
        <Field label="接入方式">
          <Select
            value={s.type}
            onChange={(e) =>
              setS({ ...s, type: e.target.value as Source["type"], ...(e.target.value==="hotlist"?{url:"https://top.baidu.com/board?tab=realtime",sourceType:"trend" as const}:{}), ...(e.target.value==="aggregated"?{query:"bilibili",url:undefined,sourceType:"trend" as const}:{}) })
            }
          >
            <option value="rss">HTTPS RSS / Atom</option>
            <option value="trends">Google Trends 地域热榜</option>
            <option value="hotlist">平台热榜（国内／国际）</option>
            <option value="aggregated">DailyHotApi 聚合热榜</option>
            <option value="github">GitHub 仓库搜索</option>
            <option value="web">Tavily 网页搜索</option>
          </Select>
        </Field>
        {s.type === "rss" && (
          <Field label="Feed 地址">
            <input
              type="url"
              required
              value={s.url || ""}
              onChange={(e) => setS({ ...s, url: e.target.value })}
            />
          </Field>
        )}
        {s.type === "trends" && (
          <Field label="地域代码（例如 US、JP）">
            <input
              required
              maxLength={2}
              value={s.region || ""}
              onChange={(e) =>
                setS({ ...s, region: e.target.value.toUpperCase() })
              }
            />
          </Field>
        )}
        {s.type === "hotlist" && <Field label="平台热榜入口"><Select value={s.url||"https://top.baidu.com/board?tab=realtime"} onChange={e=>setS({...s,url:e.target.value,sourceType:e.target.value.includes("github.com")?"repository":e.target.value.includes("hacker-news")?"community":"trend"})}><option value="https://top.baidu.com/board?tab=realtime">百度热搜</option><option value="https://s.weibo.com/top/summary?cate=realtimehot">微博热搜（可能需要登录）</option><option value="https://github.com/trending">GitHub Trending</option><option value="https://hacker-news.firebaseio.com/v0/topstories.json">Hacker News Top</option></Select></Field>}
        {s.type === "aggregated" && <Field label="聚合平台" hint="读取同一 Docker Compose 内的 DailyHotApi。只保存原平台链接与标题；聚合数据是发现线索，重要事实须另找一手证据。"><Select value={s.query||"bilibili"} onChange={e=>setS({...s,query:e.target.value,sourceType:"trend"})}><option value="bilibili">B站</option><option value="weibo">微博</option><option value="zhihu">知乎</option><option value="douyin">抖音</option><option value="kuaishou">快手</option><option value="toutiao">今日头条</option><option value="tieba">百度贴吧</option><option value="juejin">掘金</option></Select></Field>}
        {s.type === "github" && (
          <Field label="GitHub 搜索条件">
            <input
              value={s.query || ""}
              onChange={(e) => setS({ ...s, query: e.target.value })}
            />
          </Field>
        )}
        <Field label="证据类型">
          <Select
            value={s.sourceType}
            disabled={s.type === "aggregated"}
            onChange={(e) =>
              setS({ ...s, sourceType: e.target.value as Source["sourceType"] })
            }
          >
            {[
              ["official", "官方公告"],
              ["media", "媒体/聚合"],
              ["community", "真实用户/社区"],
              ["product", "产品动态"],
              ["repository", "代码项目"],
              ["trend", "趋势指标"],
              ["other", "其他"],
            ].map(([k, v]) => (
              <option value={k} key={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        {s.sourceType === "official" && s.type === "rss" && <Field label="关联官网域名（每行一个，可留空）" hint="仅填写已确认属于该机构的文档或帮助站域名，精确匹配，不自动信任其他子域名。搜索命中这些站点可识别为一手来源，仍需核对具体内容。">
          <textarea value={(s.officialDomains || []).join("\n")} onChange={e=>setS({...s,officialDomains:e.target.value.split("\n").map(v=>v.trim()).filter(Boolean)})} />
        </Field>}
        <Field label="来源说明与局限">
          <textarea
            value={s.note}
            onChange={(e) => setS({ ...s, note: e.target.value })}
          />
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={s.enabled}
            onChange={(e) => setS({ ...s, enabled: e.target.checked })}
          />
          启用此来源
        </label>
        <p className="muted">
          不支持绕过登录、验证码或付费墙。公众号与平台热榜可通过已授权的外部工具提交证据。
        </p>
        {error && <p className="error">{error}</p>}
        <footer className="form-actions">
          <button className="primary" disabled={busy}>
            保存数据源
          </button>
        </footer>
      </form>
    </Drawer>
  );
}
