"use client";
// 弹层交互（UX 修复）：所有 <details> 弹层（帮助气泡/筛选批量/更多菜单）
// 支持点击外部自动收起 + Escape 关闭——原生 details 不带此行为。
// 挂载一次于 Workbench；凡 data-popover 的 details 均自动获得该交互。
import { useEffect } from "react";

export function usePopoverAutoClose() {
  useEffect(() => {
    function onPointerDown(e: MouseEvent | PointerEvent) {
      const target = e.target as HTMLElement;
      document.querySelectorAll("details[data-popover][open]").forEach((d) => {
        if (!d.contains(target)) d.removeAttribute("open");
      });
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape")
        document.querySelectorAll("details[data-popover][open]").forEach((d) => d.removeAttribute("open"));
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);
}
