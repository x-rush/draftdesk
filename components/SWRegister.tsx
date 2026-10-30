"use client";
// Service Worker 注册（R10.39）：HTTPS 或 localhost（安全上下文）才注册；静默失败不打扰。
import { useEffect } from "react";
export function SWRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (!window.isSecureContext) return;
    navigator.serviceWorker.register("/sw.js").catch(() => { /* 注册失败静默：PWA 是增强不是依赖 */ });
  }, []);
  return null;
}
