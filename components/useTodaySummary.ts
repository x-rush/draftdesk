"use client";
// 今日总览共享小钩（R10.8 P1-2）：discover 与审查台同口径取 summary/today
import { useEffect, useState } from "react";
import { api } from "./ui";

export function useTodaySummary() {
  const [today, setToday] = useState<any>(null);
  useEffect(() => { void api<any>("summary/today").then(setToday).catch(() => setToday(null)); }, []);
  return today;
}
