// 出处核对与补录（2026-10-23 主人定的「每条结论都得能指回原话或新闻文件」）
//
// 用法（在 home 目录下跑）：
//   node tools\cite-audit.mjs            看覆盖率：记忆库和日子账里有多少条真的指得回去
//   node tools\cite-audit.mjs 补         给没出处的旧条目按字面重合机械补一处（标 ·推断）
//   node tools\cite-audit.mjs 补 --dry   只报会补什么，不动文件
//   node tools\cite-audit.mjs 查 早睡    查某件事是从哪来的：列出条目 + 出处 + 指到哪个文件
//
// 补出来的出处一律带「·推断」：那是按字面推的，不能说成模型当年抄的。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cite from "../../bot/cite.mjs";
import * as memStore from "../../bot/memory-store.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.resolve(HERE, "..");
const ARCHIVE = path.join(HOME, "archive");
const STORE = path.join(HOME, "memory", "store.json");

memStore.initMemoryStore(HOME);

const args = process.argv.slice(2);
const mode = args[0] ?? "";
const dry = args.includes("--dry");

function readStoreRaw() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch (e) {
    console.error(`读不了记忆库：${e.message}`);
    return { items: [] };
  }
}

function keyOfSession(name) {
  const s = String(name ?? "");
  if (s.startsWith("private_")) return `private:${s.slice("private_".length)}`;
  if (s.startsWith("group_")) return `group:${s.slice("group_".length)}`;
  return s;
}

function ctxOf(key, day) {
  return { home: HOME, archiveDir: ARCHIVE, key, day };
}

function isCited(it) {
  return Boolean(it.cite) && it.cite !== cite.NO_CITE;
}

// 去掉要点前缀和出处标记，只留正文
function bare(line) {
  return cite.stripCites(line).replace(/^[-·•]\s*/, "").trim();
}

// ---------- 报告 ----------

function report() {
  const store = readStoreRaw();
  const items = (store.items || []).map((x) => ({
    id: x.id,
    key: String(x.key ?? ""),
    day: String(x.day ?? ""),
    text: String(x.text ?? ""),
    cite: String(x.cite ?? ""),
    citeKind: String(x.citeKind ?? ""),
    status: String(x.status ?? "active"),
    score: Number(x.score) || 0,
  }));
  const ok = [];
  const guessed = [];
  const noCite = [];
  const broken = [];
  const inline = [];
  for (const it of items) {
    const inlineCites = cite.extractCites(it.text);
    if (!isCited(it) && inlineCites.length) {
      inline.push(it);
      continue;
    }
    if (!isCited(it)) {
      noCite.push(it);
      continue;
    }
    const r = cite.resolveCite(ctxOf(it.key, it.day), it.cite);
    if (r.ok && r.guessed) guessed.push(it);
    else if (r.ok) ok.push(it);
    else broken.push({ it, why: r.why });
  }
  const pct = (n) => (items.length ? Math.round((n / items.length) * 100) : 0);
  console.log(`记忆库 ${items.length} 条（冷藏 ${items.filter((x) => x.status === "cold").length}）`);
  console.log(
    `  指得回去 ${ok.length + guessed.length + inline.length} 条（${pct(ok.length + guessed.length + inline.length)}%）` +
      `：认定 ${ok.length}、推断 ${guessed.length}、条目里自带 ${inline.length}`,
  );
  const empty = noCite.filter((x) => !x.cite).length;
  console.log(
    `  没出处 ${noCite.length} 条（其中标了「未核实」${noCite.length - empty} 条）、写了出处但核不上 ${broken.length} 条`,
  );
  if (broken.length) {
    console.log("  —— 核不上的：");
    for (const b of broken.slice(0, 20))
      console.log(`    ${b.it.id} ${b.it.cite} ← ${b.why}｜${b.it.text.slice(0, 30)}`);
  }
  if (noCite.length) {
    console.log("  —— 没出处的（前 15 条）：");
    for (const it of noCite.slice(0, 15))
      console.log(`    ${it.id} 【${it.day || "无日期"}】${it.text.slice(0, 40)}`);
  }

  // 日子账
  let ledgers = [];
  try {
    ledgers = fs.readdirSync(ARCHIVE).filter((f) => f.endsWith(".ledger.md"));
  } catch {
    /* 没档案 */
  }
  let bullets = 0;
  let cited = 0;
  const nocite = [];
  for (const f of ledgers) {
    const key = keyOfSession(f.slice(0, -".ledger.md".length));
    let day = "";
    const raw = fs.readFileSync(path.join(ARCHIVE, f), "utf8");
    for (const line of raw.split("\n")) {
      if (/^##\s*\d{4}-\d{2}-\d{2}/.test(line)) day = line.slice(2).trim();
      if (!/^[-·•]\s*\S/.test(line)) continue;
      bullets++;
      const cs = cite.extractCites(line);
      if (!cs.length) {
        nocite.push({ key, day, text: bare(line) });
        continue;
      }
      const good = cs.filter((c) => cite.resolveCite(ctxOf(key, day), c).ok);
      if (good.length) cited++;
      else nocite.push({ key, day, text: bare(line) });
    }
  }
  console.log(`日子账 ${bullets} 条要点，带得上出处 ${cited} 条（${bullets ? Math.round((cited / bullets) * 100) : 0}%）`);
  if (nocite.length) {
    console.log(`  —— 没出处 ${nocite.length} 条（前 10 条）：`);
    for (const b of nocite.slice(0, 10))
      console.log(`    【${b.key} ${b.day || "无日期"}】${b.text.slice(0, 40)}`);
  }
  if (!nocite.length && !noCite.length && !broken.length) console.log("全部指得回去");
}

// ---------- 补录 ----------

function backfillStore() {
  const store = readStoreRaw();
  let filled = 0;
  let tried = 0;
  const miss = [];
  for (const x of store.items || []) {
    const it = { ...x, cite: String(x.cite ?? ""), day: String(x.day ?? "") };
    if (isCited(it) || !it.day) continue;
    tried++;
    const g = cite.guessCite(ctxOf(String(it.key ?? ""), it.day), it.text, {
      card: 0.55,
      news: 0.7,
    });
    if (!g) {
      miss.push(it);
      continue;
    }
    filled++;
    if (!dry) memStore.updateItem(it.id, { cite: g.cite, citeKind: "guess" });
    console.log(`  ${it.id} → ${g.cite}（重合 ${g.score.toFixed(2)}）｜${it.text.slice(0, 34)}`);
  }
  console.log(`记忆库：试补 ${tried} 条，补上 ${filled} 条，补不上 ${miss.length} 条${dry ? "（没动文件）" : ""}`);
}

function backfillLedger() {
  let files = [];
  try {
    files = fs.readdirSync(ARCHIVE).filter((f) => f.endsWith(".ledger.md"));
  } catch {
    return;
  }
  let filled = 0;
  let tried = 0;
  let miss = 0;
  for (const f of files) {
    const p = path.join(ARCHIVE, f);
    const key = keyOfSession(f.slice(0, -".ledger.md".length));
    const lines = fs.readFileSync(p, "utf8").split("\n");
    let day = "";
    let changed = false;
    const out = lines.map((line) => {
      if (/^##\s*\d{4}-\d{2}-\d{2}/.test(line)) {
        day = line.slice(2).trim();
        return line;
      }
      if (!/^[-·•]\s*\S/.test(line)) return line;
      const cs = cite.extractCites(line);
      if (cs.some((c) => cite.resolveCite(ctxOf(key, day), c).ok)) return line;
      tried++;
      const body = cite.stripCites(line);
      const g = cite.guessCite(ctxOf(key, day), body);
      if (!g) {
        miss++;
        return line;
      }
      filled++;
      changed = true;
      return `${body}${cite.citeTag(g.cite)}`;
    });
    if (changed && !dry) {
      try {
        fs.copyFileSync(p, `${p}.bak-cite`);
      } catch {
        /* 备份失败也写，旧内容还能从 store 备份推回来 */
      }
      fs.writeFileSync(p, out.join("\n"), "utf8");
      console.log(`  ${f}：补上了`);
    }
  }
  console.log(`日子账：试补 ${tried} 条，补上 ${filled} 条，补不上 ${miss} 条${dry ? "（没动文件）" : ""}`);
}

// ---------- 查 ----------

function lookup(q) {
  const needle = String(q ?? "").trim();
  if (!needle) {
    console.log("查什么？例：node tools\\cite-audit.mjs 查 早睡");
    return;
  }
  const store = readStoreRaw();
  let n = 0;
  for (const x of store.items || []) {
    if (!String(x.text ?? "").includes(needle)) continue;
    n++;
    const c = String(x.cite ?? "") || cite.extractCites(x.text).join("、");
    const r = c ? cite.resolveCite(ctxOf(String(x.key ?? ""), String(x.day ?? "")), c) : null;
    console.log(
      `${x.id}【${x.day || "无日期"}】${x.text}\n   出处：${c || "(无)"}${r ? (r.ok ? ` → ${r.rel}` : ` —— ${r.why}`) : ""}`,
    );
  }
  let files = [];
  try {
    files = fs.readdirSync(ARCHIVE).filter((f) => f.endsWith(".ledger.md"));
  } catch {
    /* 没档案 */
  }
  for (const f of files) {
    const key = keyOfSession(f.slice(0, -".ledger.md".length));
    let day = "";
    for (const line of fs.readFileSync(path.join(ARCHIVE, f), "utf8").split("\n")) {
      if (/^##\s*\d{4}-\d{2}-\d{2}/.test(line)) day = line.slice(2).trim();
      if (!line.includes(needle)) continue;
      const cs = cite.extractCites(line);
      n++;
      console.log(`日子账【${day}】${cite.stripCites(line)}\n   出处：${cs.join("、") || "(无)"}`);
    }
  }
  if (!n) console.log(`没查到「${needle}」`);
}

if (mode === "补") {
  backfillStore();
  backfillLedger();
  if (!dry) report();
} else if (mode === "查") {
  lookup(args.slice(1).join(" "));
} else {
  report();
}
