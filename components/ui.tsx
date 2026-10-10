"use client";
import { useEffect, useRef, useId, cloneElement, isValidElement } from "react";
import { X } from "lucide-react";
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
export function formatApiError(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "SCOPE_MISMATCH":
      case "SOURCE_DISABLED":
        return "当前连接没有该权限，去「外部接入」页补勾对应权限后重试。";
      case "PERMISSION_DENIED":
        return "该来源已设为只读，写入被拒绝。请在设置中调整来源权限。";
      case "NOT_FOUND":
        return "该条目可能已被删除，刷新后重试。";
      case "UNAUTHENTICATED":
        return "令牌无效或已撤销，请重新创建连接令牌。";
      case "INVALID_PAYLOAD":
        return `参数格式有误，请检查高亮字段：${e.message}`;
      case "TARGET_MISMATCH":
        return "簇的类型与请求不一致，请检查后重试。";
      case "BATCH_TOO_LARGE":
        return "批量操作超出上限，请拆分为更小的批次。";
      default:
        return e.message;
    }
  }
  if (e instanceof Error) return e.message;
  return String(e);
}
export async function api<T = any>(path: string, value?: unknown): Promise<T> {
  const r = await fetch(
    "/api/v1/" + path,
    value === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(value),
        },
  );
  const result = await r.json();
  if (!r.ok) throw new ApiError(result.error || "请求未完成", r.status, result.code);
  return result;
}
export function download(name: string, value: unknown) {
  const u = URL.createObjectURL(
    new Blob(
      [typeof value === "string" ? value : JSON.stringify(value, null, 2)],
      { type: "application/json" },
    ),
  );
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 2000);
}
export function Drawer({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current!;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    d.showModal();
    return () => { d.close(); document.body.style.overflow = previousOverflow; };
  }, []);
  return (
    <dialog
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className={"drawer " + (wide ? "wide" : "")}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header>
        <div>
          <h2 id={titleId}>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <button className="icon" aria-label="关闭面板" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      <div className="drawer-body">{children}</div>
    </dialog>
  );
}
export function Empty({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-symbol">✳</span>
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}
// 骨架屏（P2①）：数据视图首屏加载占位，替代空白/空态闪烁。
export function Skeleton({ rows = 3, label = "加载中" }: { rows?: number; label?: string }) {
  return (
    <div className="skeleton" role="status" aria-label={label}>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i} aria-hidden="true">
          <div className="skeleton-line skeleton-meta" />
          <div className="skeleton-line skeleton-title" />
          <div className="skeleton-line skeleton-text" />
        </div>
      ))}
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  const id = useId();
  return (
    <label className="field">
      <span id={id}>{label}</span>
      {isValidElement(children) ? cloneElement(children as React.ReactElement<Record<string, unknown>>, {"aria-labelledby": id, ...(hint ? {"aria-describedby": id + "-hint"} : {})}) : children}
      {hint && <small id={id + "-hint"}>{hint}</small>}
    </label>
  );
}
export const kindLabels = {
  news: "AI 资讯",
  topic: "内容选题",
  trend: "热词趋势",
  idea: "应用机会",
  activity: "创作活动",
};
export const kindPlanLabels = {
  editorial: "资讯与选题",
  trends: "热词趋势",
  opportunity: "应用机会",
  activities: "创作活动与激励",
};
export function date(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
