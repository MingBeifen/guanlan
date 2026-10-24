// 记忆库体检（2026-10-23 主人点头的四步之外顺手加的）
// 只看不动：不写库、不改状态、不花模型钱。
//   node tools/memory-audit.mjs            看整体：分层、键、待判对、过时条目、互联
//   node tools/memory-audit.mjs 重复        只找还像得能并、但没并到一起的同一件事
//   node tools/memory-audit.mjs 待判        只列等夜里判的几对
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.resolve(HERE, "..");
const STORE_FILE = path.join(HOME, "memory", "store.json");
const PENDING_FILE = path.join(HOME, "memory", "pending.json");

const norm = (t) =>
  String(t ?? "")
    .replace(/\s+/g, " ")
    .replace(/[。．.；;，,、]+$/g, "")
    .trim()
    .toLowerCase();

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
}

function bigrams(t) {
  const s = norm(t).replace(/[\s\p{P}\p{S}]+/gu, "");
  const out = new Set();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  if (!out.size && s) out.add(s);
  return out;
}

function sim(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const jacc = inter / (A.size + B.size - inter);
  const min = Math.min(A.size, B.size);
  if (min < 6) return jacc;
  return (jacc + inter / min) / 2;
}

const store = readJson(STORE_FILE, { items: [] });
const items = Array.isArray(store.items) ? store.items : [];
const pending = readJson(PENDING_FILE, []);
const mode = process.argv[2] || "";

const short = (t, n = 46) => {
  const s = String(t ?? "").replace(/\n/g, " ").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
};

if (mode === "待判") {
  if (!pending.length) console.log("没有等判的对。");
  for (const p of pending) {
    console.log(`\n[${p.key}] 像 ${p.sim}`);
    console.log(`  旧 ${p.a}：${short(p.aText, 70)}`);
    console.log(`  新 ${p.b}：${short(p.bText, 70)}`);
  }
  process.exit(0);
}

if (mode === "重复") {
  const live = items.filter((x) => x.status === "active");
  let n = 0;
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (a.key !== b.key) continue;
      const s = sim(a.text, b.text);
      const na = norm(a.text);
      const nb = norm(b.text);
      const long = Math.min(na.length, nb.length);
      const contained = long >= 12 && (na.includes(nb) || nb.includes(na));
      if (s < 0.75 && !contained) continue;
      n++;
      console.log(`\n[${a.key}] ${s.toFixed(2)}${contained ? "（一条包着另一条）" : ""}`);
      console.log(`  ${a.id} 分${a.score} ${short(a.text, 70)}`);
      console.log(`  ${b.id} 分${b.score} ${short(b.text, 70)}`);
    }
  }
  console.log(n ? `\n共 ${n} 对还像重复。` : "没找到还像重复的。");
  process.exit(0);
}

// 整体
const byLayer = { core: 0, long: 0, mid: 0, short: 0 };
const byStatus = { active: 0, cold: 0, superseded: 0 };
const keys = {};
let linked = 0;
let linkPairs = 0;
for (const x of items) {
  byStatus[x.status] = (byStatus[x.status] ?? 0) + 1;
  if (x.status === "active") byLayer[x.layer] = (byLayer[x.layer] ?? 0) + 1;
  keys[x.key] = (keys[x.key] ?? 0) + 1;
  const ls = Array.isArray(x.links) ? x.links : [];
  if (ls.length) linked++;
  linkPairs += ls.length;
}
console.log(`记忆库 ${items.length} 条：${Object.entries(byLayer).map(([k, v]) => `${k} ${v}`).join("、")}`);
console.log(
  `状态：active ${byStatus.active}、cold ${byStatus.cold ?? 0}、superseded（被顶掉的旧说法）${byStatus.superseded ?? 0}`,
);
console.log(`互联：${linked} 条挂着 links，共 ${linkPairs} 根（双向各算一次）`);
console.log("分键：");
for (const [k, v] of Object.entries(keys).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${v}`);
const badKeys = Object.keys(keys).filter((k) => /^(private|group)_\d+$/.test(k));
if (badKeys.length) console.log(`  ⚠ 还有老键没折：${badKeys.join("、")}（重启一次会自动折）`);
console.log(`待判：${pending.length} 对${pending.length ? "（node tools/memory-audit.mjs 待判 看内容）" : ""}`);
const sup = items.filter((x) => x.status === "superseded");
if (sup.length) {
  console.log("被顶掉的旧说法（留着版本，不进提示词）：");
  for (const x of sup.slice(0, 12)) console.log(`  ${x.id} 被 ${x.supersededBy || "?"} 顶掉：${short(x.text)}`);
}
const live = items.filter((x) => x.status === "active");
let dup = 0;
for (let i = 0; i < live.length; i++)
  for (let j = i + 1; j < live.length; j++) {
    if (live[i].key !== live[j].key) continue;
    if (sim(live[i].text, live[j].text) >= 0.75) dup++;
  }
console.log(`还可能重复：${dup} 对${dup ? "（node tools/memory-audit.mjs 重复 看内容）" : ""}`);
