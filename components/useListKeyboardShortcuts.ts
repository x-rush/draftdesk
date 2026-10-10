"use client";
// 键盘流（信息架构 v2-9c）：J/K 移动卡片、A 通过、X 归档、D 讨论。
// 列表页全局监听；输入框/下拉/文本域聚焦时自动失效。
import { useEffect } from "react";

export function useListKeyboardShortcuts(
  cardSelector: string,
  actions: { approve: () => void; archive: () => void; discuss: () => void },
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    let index = -1;
    const highlight = () => {
      const cards = Array.from(document.querySelectorAll(cardSelector));
      cards.forEach((c, i) => ((c as HTMLElement).style.outline = i === index ? "2px solid var(--ink)" : ""));
      if (index >= 0 && cards[index]) (cards[index] as HTMLElement).scrollIntoView({ block: "nearest" });
    };
    const handler = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || t.isContentEditable) return;
      const cards = Array.from(document.querySelectorAll(cardSelector));
      if (e.key === "j" || e.key === "J") { index = Math.min(cards.length - 1, index + 1); highlight(); }
      else if (e.key === "k" || e.key === "K") { index = Math.max(0, index - 1); highlight(); }
      else if (e.key === "a" || e.key === "A") { if (index >= 0) { actions.approve(); e.preventDefault(); } }
      else if (e.key === "x" || e.key === "X") { if (index >= 0) { actions.archive(); e.preventDefault(); } }
      else if (e.key === "d" || e.key === "D") { if (index >= 0) { actions.discuss(); e.preventDefault(); } }
    };
    window.addEventListener("keydown", handler);
    return () => { window.removeEventListener("keydown", handler); document.querySelectorAll(cardSelector).forEach((c) => ((c as HTMLElement).style.outline = "")); };
  }, [enabled, cardSelector, actions]);
}
