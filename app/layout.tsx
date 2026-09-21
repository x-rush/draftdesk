import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "拾题 DraftDesk · 智能选题工作台",
  description: "用证据发现值得写的选题与值得验证的应用。",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
