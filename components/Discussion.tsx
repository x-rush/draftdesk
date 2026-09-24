"use client";
import { useEffect, useRef, useState } from "react";
import type { Artifact, ArtifactDraft, Conversation } from "../core/schema";
import { api, Empty, date } from "./ui";
import { ArtifactEditor } from "./ArtifactPanel";
import { MessageContent } from "./MessageContent";
type Summary = {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
};
export function Discussion({
  artifact,
  history,
  onChange,
}: {
  artifact?: Artifact;
  history: Summary[];
  onChange: () => Promise<void>;
}) {
  const [conversation, setConversation] = useState<Conversation>({
      id: "",
      title: "新讨论",
      messages: [],
      updatedAt: "",
    }),
    [message, setMessage] = useState(""),
    [stream, setStream] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [working, setWorking] = useState(false),
    [search, setSearch] = useState(""),
    [draft, setDraft] = useState<{
      draft: ArtifactDraft;
      jobId: string;
    } | null>(null),
    [ready, setReady] = useState(false),
    [context,setContext]=useState<Artifact>(),
    [savedNotice,setSavedNotice]=useState("");
  useEffect(()=>{
    let alive=true;setContext(undefined);
    if(conversation.artifactId)void api<Artifact>("artifacts/"+conversation.artifactId).then(a=>{if(alive)setContext(a)}).catch(()=>{if(alive)setError("关联内容读取失败，暂不能整理或更新原内容。")});
    return()=>{alive=false};
  },[conversation.artifactId]);
  const abort = useRef<AbortController | null>(null),
    bottom = useRef<HTMLDivElement>(null);
  const draftKey = "draftdesk.discussion.v2";
  useEffect(() => {
    try {
      const cached = JSON.parse(localStorage.getItem(draftKey) || "null");
      if (
        !artifact &&
        cached?.conversation?.id &&
        Array.isArray(cached.conversation.messages)
      ) {
        setConversation(cached.conversation);
        setMessage(typeof cached.message === "string" ? cached.message : "");
        if (cached.draft?.draft?.title) setDraft(cached.draft);
        void api<Conversation>("conversations/" + cached.conversation.id)
          .then(setConversation)
          .catch(() => {});
      } else
        setConversation({
          id: crypto.randomUUID(),
          title: artifact?.title || "新讨论",
          artifactId: artifact?.id,
          messages: [],
          updatedAt: "",
        });
    } catch {
      setConversation({
        id: crypto.randomUUID(),
        title: "新讨论",
        messages: [],
        updatedAt: "",
      });
    }
    setReady(true);
    return () => abort.current?.abort();
  }, [artifact?.id]);
  useEffect(() => {
    if (ready)
      try {
        localStorage.setItem(
          draftKey,
          JSON.stringify({ conversation, message, draft }),
        );
      } catch {
        setError("草稿存储空间不足，请复制重要内容。");
      }
  }, [conversation, message, draft, ready]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" });
  }, [stream, conversation.messages.length]);
  async function send() {
    if (!message.trim() || busy) return;
    setBusy(true);
    setError("");
    setStream("");
    const controller = new AbortController();
    abort.current = controller;
    let done = false;
    try {
      const response = await fetch("/api/v1/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          id: conversation.id,
          artifactId: conversation.artifactId,
          message,
        }),
      });
      if (!response.ok) {
        const v = await response.json();
        throw new Error(v.error || "讨论连接失败");
      }
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      let pending = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        let index;
        while ((index = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, index);
          pending = pending.slice(index + 1);
          if (!line.trim()) continue;
          const e = JSON.parse(line);
          if (e.type === "delta") setStream((s) => s + e.text);
          if (e.type === "notice") setError(e.message);
          if (e.type === "error") throw new Error(e.message);
          if (e.type === "done") {
            setConversation(e.conversation);
            setMessage("");
            setStream("");
            done = true;
          }
        }
      }
      if (!done)
        throw new Error("连接中断，输入保留；稍后从历史讨论查看已保存回复。");
      await onChange();
    } catch (e) {
      setError(
        controller.signal.aborted
          ? "已请求停止。已生成内容会在服务端保存，可从历史讨论重新打开。"
          : (e as Error).message,
      );
    } finally {
      setBusy(false);
      abort.current = null;
      void onChange();
    }
  }
  async function open(id: string) {
    setError("");
    try {
      setDraft(null);setSavedNotice("");
      setConversation(await api<Conversation>("conversations/" + id));
      setMessage("");
      setStream("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="discussion-layout">
      <aside className="history">
        <button
          disabled={busy || working}
          onClick={() => {
            setDraft(null);setSavedNotice("");
            setConversation({
              id: crypto.randomUUID(),
              title: "新讨论",
              messages: [],
              updatedAt: "",
            });
            setMessage("");
            setStream("");
          }}
        >
          ＋ 新讨论
        </button>
        <input
          aria-label="搜索历史讨论"
          placeholder="搜索历史讨论"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {history
          .filter((c) => c.title.includes(search))
          .map((c) => (
            <button
              disabled={busy || working}
              className={c.id === conversation.id ? "active" : ""}
              key={c.id}
              onClick={() => void open(c.id)}
            >
              <strong>{c.title}</strong>
              <small>
                {c.messageCount} 条消息 · {date(c.updatedAt)}
              </small>
            </button>
          ))}
      </aside>
      <section className="chat-panel">
        <header>
          <h2>{conversation.title}</h2>
          <p>
            {conversation.artifactId
              ? "已关联研究产物与原始证据"
              : "自由讨论；从一条发现进入可带入证据"}
          </p>
          {context&&<details className="discussion-context"><summary>本次讨论的材料：{context.title} · {context.evidenceIds.length} 条证据</summary><p>{context.summary}</p><p>面向：{context.audience}</p><p>带入内容结构、事实结论、待核实问题与关联证据。没有关联的资料不会自动加入。</p></details>}
          <span className="pill">私人讨论 · 不自动联网</span>
        </header>
        <div className="toolbar">
          <button
            disabled={
              busy ||
              working ||
              !context ||
              !conversation.messages.length
            }
            onClick={() => {
              setWorking(true);
              void api("distill", { id: conversation.id, kind: "topic" })
                .then(setDraft)
                .catch((e) => setError(e.message))
                .finally(() => setWorking(false));
            }}
          >
            整理为内容选题
          </button>
          <button
            disabled={
              busy ||
              working ||
              !context ||
              !conversation.messages.length
            }
            onClick={() => {
              setWorking(true);
              void api("distill", { id: conversation.id, kind: "idea" })
                .then(setDraft)
                .catch((e) => setError(e.message))
                .finally(() => setWorking(false));
            }}
          >
            整理为应用方案
          </button>
          <button
            disabled={!conversation.messages.length}
            onClick={() =>
              void navigator.clipboard
                .writeText(
                  conversation.messages
                    .map(
                      (m) =>
                        (m.role === "user" ? "我" : "AI") + "：" + m.content,
                    )
                    .join("\n\n"),
                )
                .catch(() => setError("复制失败，请手动选择文字。"))
            }
          >
            复制讨论
          </button>
          {working && <span>正在按研究 Skill 整理…</span>}
        </div>
        {savedNotice&&<p role="status" className="notice">{savedNotice}</p>}
        <div className="messages" aria-live="polite">
          {!conversation.messages.length && !busy && (
            <Empty title="从一个具体问题开始">
              把观点变成可论证的选题，把需求变成可验证的产品。可以询问：“这个结论还缺什么证据？”
            </Empty>
          )}
          {conversation.messages.map((m, i) => (
            <article key={i} className={"message " + m.role}>
              <strong>{m.role === "user" ? "你" : "研究搭档"}</strong>
              {m.role === "assistant" ? <MessageContent text={m.content} /> : <div>{m.content}</div>}
              {m.status && (
                <small>
                  未完成回复 · {m.status === "stopped" ? "已停止" : "连接中断"}
                </small>
              )}
            </article>
          ))}
          {busy && (
            <article className="message assistant">
              <strong>研究搭档</strong>
              <MessageContent text={stream || "正在推敲证据与方向…"} />
            </article>
          )}
          {!busy && stream && (
            <article className="message assistant">
              <strong>已收到的部分回复</strong>
              <MessageContent text={stream} />
            </article>
          )}
          <div ref={bottom} />
        </div>
        {error && (
          <p className="error" role="status">
            {error}
          </p>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            aria-label="讨论消息"
            maxLength={10000}
            placeholder="描述你的问题、读者或想验证的假设…"
            value={message}
            disabled={busy || working}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (
                (e.ctrlKey || e.metaKey) &&
                e.key === "Enter" &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div>
            <small>草稿保存在此浏览器 · Ctrl / ⌘ + Enter 发送</small>
            {busy ? (
              <button type="button" onClick={() => abort.current?.abort()}>
                停止生成
              </button>
            ) : (
              <button className="primary" disabled={!message.trim() || !ready}>
                发送
              </button>
            )}
          </div>
        </form>
      </section>
      {draft && (
        <ArtifactEditor
          initial={draft.draft}
          target={
            context
          }
          onClose={() => setDraft(null)}
          onSave={async (d, update) => {
            if (update && context)
              await api("artifacts", {
                id: context.id,
                revision: context.revision,
                draft: d,
              });
            else await api("save-draft", { draft: d, jobId: draft.jobId });
            await onChange();
            if(context)setContext(await api<Artifact>("artifacts/"+context.id));
            setSavedNotice(update?"已更新原内容，保留原有创作进度，内容需重新核实。":"已保存到我的选题库，可继续安排创作。");
            setDraft(null);
          }}
        />
      )}
    </div>
  );
}
