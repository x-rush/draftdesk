"use client";
import { Clock3 } from "lucide-react";
import { Select } from "./Select";
export function TimePicker({value, onChange, ...props}: {value: string; onChange: (value: string) => void; "aria-labelledby"?: string}) {
  const [hour, minute] = value.split(":");
  const options = (length: number) => Array.from({length}, (_, n) => String(n).padStart(2, "0"));
  return <span className="time-picker" role="group" aria-labelledby={props["aria-labelledby"]}>
    <Clock3 size={18} aria-hidden="true"/>
    <Select aria-label="北京时间小时" value={hour} onChange={e => onChange(`${e.target.value}:${minute}`)}>{options(24).map(n => <option value={n} key={n}>{n} 时</option>)}</Select>
    <span aria-hidden="true">:</span>
    <Select aria-label="北京时间分钟" value={minute} onChange={e => onChange(`${hour}:${e.target.value}`)}>{options(60).map(n => <option value={n} key={n}>{n} 分</option>)}</Select>
  </span>;
}
