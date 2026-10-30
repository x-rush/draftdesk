import type { MetadataRoute } from "next";

// PWA manifest（R10.39）：HTTPS 部署后「添加到主屏幕」成独立应用窗口。
// 主题与应用一致（墨绿 #253b32 / 纸色 #f6f5f0）；shortcuts 给最高频三入口。
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "拾题 DraftDesk · 智能选题工作台",
    short_name: "拾题",
    description: "用证据发现值得写的选题与值得验证的应用。",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    background_color: "#f6f5f0",
    theme_color: "#253b32",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "审查台", url: "/?view=decisions&source=pwa", description: "拍板今日待审选题" },
      { name: "每日发现", url: "/?view=discover&source=pwa", description: "今日采集与聚类" },
      { name: "选题队列", url: "/?view=ideas&source=pwa", description: "待拍选题队列" },
    ],
  };
}
