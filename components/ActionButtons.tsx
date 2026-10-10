"use client";
// 统一操作模型（信息架构 v2-2）：所有列表卡片的三按钮中可复用的部分。
// 归档用行内二次确认（按钮变「确认归档？」3 秒），不用弹窗（9c 规范）。
import { useEffect, useState } from "react";

export function ArchiveButton({ onConfirm, disabled, label = "归档" }: { onConfirm: () => void; disabled?: boolean; label?: string }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(false), 3000);
    return () => clearTimeout(timer);
  }, [confirming]);
  return (
    <button
      disabled={disabled}
      className={confirming ? "danger" : ""}
      aria-label={confirming ? "确认归档" : `归档（${label}）`}
      onClick={() => (confirming ? onConfirm() : setConfirming(true))}
    >
      {confirming ? "确认归档？" : label}
    </button>
  );
}

export type DiscussContext = { title: string; url: string; source: string };
