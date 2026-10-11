// SeoWorkspaceView：删除 matched/intent 两个废弃 tab 与渲染块
import { readFileSync, writeFileSync } from "node:fs";
const p = "components/views/SeoWorkspaceView.tsx";
let s = readFileSync(p, "utf8");
const nl = s.includes("\r\n") ? "\r\n" : "\n";
const j = (lines) => lines.join(nl);

// 1) tab 类型收窄
s = s.replace(
  '  const [tab, setTab] = useState<"radar" | "terms" | "matched" | "intent">("radar");',
  '  const [tab, setTab] = useState<"radar" | "terms">("radar");',
);

// 2) nav 三按钮 → 单按钮
const navOld = j([
  '      <nav className="discovery-modes" aria-label="SEO 板块">',
  '        {[["terms", "全量热词"], ["matched", "选题×搜索词"], ["intent", "意图分层"]].map(([id, label]) => (',
  '          <button key={id} className={tab === id ? "active" : ""} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id as typeof tab)}>{label}</button>',
  "        ))}",
  "      </nav>",
]);
if (!s.includes(navOld)) { console.error("nav mismatch"); process.exit(1); }
s = s.replace(navOld, j([
  '      <nav className="discovery-modes" aria-label="SEO 板块">',
  '        <button className="active" aria-current="page">全量热词</button>',
  "      </nav>",
]));

// 3) 空态条件
s = s.replace(
  '      {ws.seenLoading && !ws.seenList.items.length && !terms.length && tab !== "radar" && <Skeleton rows={3} label="热词趋势加载中" />}',
  "      {ws.seenLoading && !ws.seenList.items.length && !terms.length && <Skeleton rows={3} label=\"热词趋势加载中\" />}",
);
s = s.replace(
  '      {terms.length === 0 && tab !== "radar" && <Empty title="还没有搜索词数据。">',
  '      {terms.length === 0 && <Empty title="还没有搜索词数据。">',
);

// 4) matched 块删除（条件行 → </div>)} 行尾）
const mA = s.indexOf('      {terms.length > 0 && tab === "matched" && (');
if (mA < 0) { console.error("matched missing"); process.exit(1); }
let e1 = s.indexOf("</div>)}", mA);
e1 += "</div>)}".length;
while (s[e1] === "\r" || s[e1] === "\n") e1++;
// intent 块删除（条件行 → '})}\n      }' 行尾）
const iB = s.indexOf('      {terms.length > 0 && tab === "intent" && (', e1);
if (iB < 0) { console.error("intent missing"); process.exit(1); }
const tailA = "})}" + nl + "      }" + nl;
let e2 = s.indexOf(tailA, iB);
if (e2 < 0) { console.error("intent end missing"); process.exit(1); }
e2 += tailA.length;
// 从后往前删避免位移
s = s.slice(0, iB) + s.slice(e2);
s = s.slice(0, mA) + s.slice(e1);

writeFileSync(p, s);
console.log("surgical ok");
