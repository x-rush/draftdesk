"use client";
// 登录页（R10.39）：DRAFTDESK_ACCESS_CODE 启用时的会话入口。移动优先的一屏卡。
import { useState } from "react";

export default function LoginPage() {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!code.trim() || busy) return;
    setBusy(true); setError("");
    try {
      const r = await fetch("/api/v1/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (r.ok) { location.href = new URLSearchParams(location.search).get("next") || "/"; return; }
      const body = await r.json().catch(() => ({}));
      setError(body.error || "登录失败，请重试。");
    } catch {
      setError("网络异常，请重试。");
    } finally { setBusy(false); }
  }

  return (
    <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 24 }}>
      <form
        onSubmit={(e) => { e.preventDefault(); void submit(); }}
        style={{ width: "min(360px, 100%)", display: "grid", gap: 14 }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {/* 与应用图标同源：墨绿圆角方 + 白羽笔 */}
          <svg width="40" height="40" viewBox="0 0 64 64" aria-hidden>
            <rect width="64" height="64" rx="14" fill="#253b32" />
            <g transform="translate(20,20)" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" />
              <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />
            </g>
          </svg>
          <div>
            <h1 style={{ margin: 0, fontSize: 20 }}>拾题 DraftDesk</h1>
            <p style={{ margin: 0, color: "var(--muted, #66736c)", fontSize: 13 }}>输入访问码进入工作台</p>
          </div>
        </div>
        <input
          type="password"
          inputMode="text"
          autoComplete="current-password"
          placeholder="访问码"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoFocus
          style={{ fontSize: 16, padding: "12px 14px", borderRadius: 8, border: "1px solid var(--line, #dfe3d9)", background: "#fff" }}
        />
        {error && <p role="alert" style={{ margin: 0, color: "#8a3a3a", fontSize: 13 }}>{error}</p>}
        <button
          type="submit"
          disabled={busy || !code.trim()}
          style={{ fontSize: 15, padding: "12px 16px", borderRadius: 8, border: 0, background: "#315c46", color: "#fff", minHeight: 44 }}
        >
          {busy ? "验证中…" : "进入工作台"}
        </button>
        <p style={{ margin: 0, color: "var(--muted, #66736c)", fontSize: 12 }}>会话有效期 30 天；外部 Agent 令牌不受影响。</p>
      </form>
    </main>
  );
}
