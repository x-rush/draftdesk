"use client";
import { useEffect, useRef, useId, cloneElement, isValidElement } from "react";
import { X } from "lucide-react";
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
  if (!r.ok) throw new Error(result.error || "请求未完成");
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
  person: "人物观察",
  activity: "创作活动",
};
export const kindPlanLabels = {
  editorial: "资讯与选题",
  trends: "热词趋势",
  opportunity: "应用机会",
  people: "人物与作者",
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
