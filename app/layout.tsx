import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SWRegister } from "../components/SWRegister";

export const metadata: Metadata = {
  title: "拾题 DraftDesk · 智能选题工作台",
  description: "用证据发现值得写的选题与值得验证的应用。",
  applicationName: "拾题",
  // iOS「添加到主屏幕」适配（R10.39 PWA）：独立窗口 + 图标 + 状态栏
  appleWebApp: { capable: true, statusBarStyle: "default", title: "拾题" },
  icons: {
    icon: [{ url: "/icon-192.png", sizes: "192x192", type: "image/png" }, { url: "/icon-512.png", sizes: "512x512", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#253b32",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}<SWRegister /></body>
    </html>
  );
}
