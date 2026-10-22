// 本地向量记忆
// 做的事：把档案页、日记、事件卡、日子账、原话底账切块 -> 本地 bge-base-zh 编码 -> 存 home\memory\vectors\index.json
// 查的时候：一句话编码，跟索引里的块算余弦，取最像的几条。
// 全部在本机跑，不花钱；模型在 home\models\bge-base-zh-v1.5。
//
// 命令行：
//   node vector-memory.mjs build            重建索引（默认全量，几十秒）
//   node vector-memory.mjs query "问题" [scope]   手动查一次看看
//   node vector-memory.mjs stats            看索引有多少条、多大
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = path.resolve(HERE, "..");
const KIT = path.resolve(HOME, "..");
const MODEL_DIR = path.join(HOME, "models");
const MODEL_NAME = "bge-base-zh-v1.5";
const INDEX_DIR = path.join(HERE, "vectors");
const INDEX_FILE = path.join(INDEX_DIR, "index.json");
const STORE_FILE = path.join(HERE, "store.json");
const LAYER_LABEL = { core: "永久", long: "长期", mid: "中期", short: "短期" };
const PAGE_DIR = path.join(HOME, "档案");
const DIARY_DIR = path.join(HOME, "档案");
const ARCHIVE_DIR = path.join(HOME, "archive");
const DAYS_DIR = path.join(ARCHIVE_DIR, "days");
// bge 官方建议：短查询前面加这句，检索更准；存进索引的正文不加。
const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";
const CHUNK_CHARS = 260;
const MAX_ITEMS_PER_SOURCE = 4000;

let extractorPromise = null;
function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { env, pipeline } = await import("@huggingface/transformers");
      env.allowRemoteModels = false;
      env.allowLocalModels = true;
      env.localModelPath = MODEL_DIR + path.sep;
      env.cacheDir = path.join(MODEL_DIR, ".cache");
      const ex = await pipeline("feature-extraction", MODEL_NAME, {
        dtype: "fp32",
      });
      return ex;
    })();
  }
  return extractorPromise;
}

async function encode(texts) {
  const ex = await getExtractor();
  const list = texts.length ? texts : [""];
  const out = await ex(list, { pooling: "cls", normalize: true });
  const dim = out.dims[1];
  const rows = [];
  for (let i = 0; i < list.length; i++)
    rows.push(Float32Array.from(out.data.slice(i * dim, (i + 1) * dim)));
  return { dim, rows };
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// ---------- 切块 ----------

// markdown：按空行和标题切开，再攒到 200~400 字一块，别把一句话劈两半
function chunkMarkdown(raw) {
  const lines = String(raw).replace(/\r/g, "").split("\n");
  const blocks = [];
  let buf = [];
  for (const line of lines) {
    const isHead = /^#{1,6}\s/.test(line.trim());
    const isBullet = /^\s*([-*+]|\d+\.)\s/.test(line);
    if (!line.trim() || isHead || (isBullet && buf.join("").length > CHUNK_CHARS)) {
      if (buf.length) blocks.push(buf.join("\n").trim());
      buf = [];
      if (isHead) blocks.push(line.trim());
      continue;
    }
    buf.push(line);
  }
  if (buf.length) blocks.push(buf.join("\n").trim());

  // 小块并大块，大块按句子切开
  const chunks = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (const b of blocks.filter(Boolean)) {
    if (cur && (cur + "\n" + b).length > CHUNK_CHARS * 2) flush();
    if (b.length <= CHUNK_CHARS * 2) {
      cur = cur ? cur + "\n" + b : b;
      continue;
    }
    for (const sent of b.split(/(?<=[。！？；\n])/)) {
      if (!sent.trim()) continue;
      if (cur.length + sent.length > CHUNK_CHARS) flush();
      cur += sent;
    }
  }
  flush();
  return chunks;
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

// 事件卡：一天一个目录，一张卡一段话说
function collectDayCards(key) {
  const out = [];
  const base = path.join(DAYS_DIR, key.replace(/[^A-Za-z0-9_-]/g, "_"));
  let days = [];
  try {
    days = fs.readdirSync(base).sort();
  } catch {
    return out;
  }
  for (const day of days) {
    const dir = path.join(base, day);
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    let cur = "";
    for (const f of files.slice(0, MAX_ITEMS_PER_SOURCE)) {
      const body = readText(path.join(dir, f)).trim();
      if (!body) continue;
      if (cur && cur.length + body.length > CHUNK_CHARS) {
        out.push({ day, text: cur.trim() });
        cur = "";
      }
      cur += (cur ? "\n" : "") + body;
    }
    if (cur.trim()) out.push({ day, text: cur.trim() });
  }
  return out;
}

// 原话底账：两三句并成一块（块太大就被无关的话稀释，查不准），带日期
function collectRawTalk(key, step = 3, maxChars = 240) {
  const file = path.join(
    ARCHIVE_DIR,
    key.replace(/[^A-Za-z0-9_-]/g, "_") + ".jsonl",
  );
  const out = [];
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return out;
  }
  const recs = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r?.text) recs.push(r);
    } catch {
      /* 坏行跳过 */
    }
  }
  let cur = [];
  let curDay = "";
  let size = 0;
  const flush = () => {
    if (!cur.length) return;
    out.push({
      day: curDay,
      text: cur.join("\n"),
    });
    cur = [];
    size = 0;
  };
  for (const r of recs) {
    const day = r.ts
      ? new Date(r.ts + 8 * 3600 * 1000).toISOString().slice(0, 10)
      : "";
    const line = `${r.role === "me" ? "我" : "对方"}：${String(r.text).slice(0, 300)}`;
    // 换天、块满、句数到上限，都断开
    if (cur.length && (day !== curDay || size + line.length > maxChars || cur.length >= step))
      flush();
    if (!cur.length) curDay = day;
    cur.push(line);
    size += line.length;
  }
  flush();
  return out.slice(-MAX_ITEMS_PER_SOURCE);
}

// 日子账 / 当天小结：按 ## 日期分段
function collectLedger(key) {
  const out = [];
  for (const suffix of [".ledger.md", ".short.md"]) {
    const p = path.join(
      ARCHIVE_DIR,
      key.replace(/[^A-Za-z0-9_-]/g, "_") + suffix,
    );
    const raw = readText(p).trim();
    if (!raw) continue;
    for (const sec of raw.split(/\n(?=## )/)) {
      const day = (sec.match(/^##\s*(\S+)/) ?? [])[1] ?? "";
      for (const c of chunkMarkdown(sec)) out.push({ day, text: c });
    }
  }
  return out;
}

// ---------- 建索引 ----------

// 五层记忆库（store.json）：控制台里改完/新加/删掉的条目，靠 syncStore 增量补进索引，
// 不用为了改一条就把 674 块全重算一遍。
function hashText(t) {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0;
  return h.toString(36) + ":" + t.length;
}

function collectStore() {
  const out = [];
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    return out;
  }
  for (const it of data.items ?? []) {
    if (!it || it.status === "cold") continue; // 冷藏的不该被想起来
    const text = String(it.text ?? "").trim();
    if (text.length < 8) continue;
    const scope = it.key === "shared" || !it.key ? "shared" : it.key;
    // 来处也写进 src：全解开以后群里会翻到别的群和私聊的旧事，得一眼看出是哪边的
    const where =
      scope === "shared"
        ? ""
        : /^group:/.test(scope)
          ? `【群${scope.slice("group:".length)}】`
          : "【私聊】";
    out.push({
      id: "store:" + it.id,
      sid: it.id,
      scope,
      src: `${where}记忆/${LAYER_LABEL[it.layer] ?? it.layer ?? "记忆"}`,
      day: it.day || "",
      text,
      hash: hashText(text),
    });
  }
  return out;
}

export async function buildIndex({ quiet = false } = {}) {
  const say = (s) => {
    if (!quiet) console.log(s);
  };
  const items = [];
  const push = (scope, src, day, texts) => {
    for (const t of texts) {
      if (t && t.trim().length >= 8) items.push({ scope, src, day: day || "", text: t.trim() });
    }
  };

  // 1) 档案五页：两边都能用（群里也认「我是谁、规矩」这类底子）
  let pageFiles = [];
  try {
    pageFiles = fs.readdirSync(PAGE_DIR).filter((f) => f.endsWith(".md")).sort();
  } catch {
    /* 没档案页就跳过 */
  }
  for (const f of pageFiles) {
    const raw = readText(path.join(PAGE_DIR, f));
    push("shared", `档案/${f}`, "", chunkMarkdown(raw));
  }

  // 2) 日记：只给私聊用
  let diaryFiles = [];
  try {
    diaryFiles = fs.readdirSync(DIARY_DIR).filter((f) => f.endsWith(".md")).sort();
  } catch {
    /* 没日记就跳过 */
  }
  for (const f of diaryFiles) {
    const raw = readText(path.join(DIARY_DIR, f));
    push("private", `日记/${f}`, "", chunkMarkdown(raw));
  }

  // 3) 每个会话自己的：事件卡、日子账、当天小结、原话底账
  let keys = [];
  try {
    keys = fs
      .readdirSync(ARCHIVE_DIR)
      .filter((f) => f.endsWith(".jsonl") && f !== "keep.jsonl")
      .map((f) => f.replace(/\.jsonl$/, ""));
  } catch {
    /* 没档案就跳过 */
  }
  for (const slug of keys) {
    const scope = slug.replace(/_/g, ":", 1).startsWith("group:")
      ? "group:" + slug.split("_").slice(1).join("_")
      : "private:" + slug.split("_").slice(1).join("_");
    const tag = slug.startsWith("group") ? `群${scope.slice("group:".length)}` : "私聊";
    for (const c of collectDayCards(scope)) push(scope, `事件卡/${tag}/${c.day}`, c.day, [c.text]);
    push(scope, `日子账/${tag}`, "", collectLedger(scope).map((c) => c.text));
    for (const c of collectRawTalk(scope)) push(scope, `原话/${tag}/${c.day}`, c.day, [c.text]);
  }

  // 4) 五层记忆库：条目按归属进对应 scope，控制台的增删改由 syncStore 增量维护
  let storeItems = 0;
  for (const it of collectStore()) {
    items.push({ scope: it.scope, src: it.src, day: it.day, text: it.text, id: it.id, sid: it.sid, hash: it.hash });
    storeItems++;
  }
  if (storeItems) say(`记忆库 ${storeItems} 条也进索引`);

  say(`切出 ${items.length} 块，开始编码…`);
  const t0 = Date.now();
  const vecs = [];
  const BATCH = 24;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    const { rows } = await encode(batch.map((x) => x.text));
    vecs.push(...rows);
    if (!quiet && (i / BATCH) % 5 === 0)
      process.stdout.write(`  ${Math.min(i + BATCH, items.length)}/${items.length}\r`);
  }
  const dim = vecs[0]?.length ?? 0;
  const out = {
    model: MODEL_NAME,
    dim,
    builtAt: new Date().toISOString(),
    count: items.length,
    items: items.map((it, i) => ({
      ...it,
      vec: Buffer.from(vecs[i].buffer, vecs[i].byteOffset, vecs[i].byteLength).toString("base64"),
    })),
  };
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, JSON.stringify(out), "utf8");
  const mb = (fs.statSync(INDEX_FILE).size / 1048576).toFixed(1);
  say(
    `索引写好：${items.length} 条，${dim} 维，${mb}MB，用 ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${INDEX_FILE}`,
  );
  return out;
}

// 增量同步：只补新加/改过的记忆库条目、删掉已删除的，不碰档案那 674 块。
// 面板保存/删除后起一个子进程跑这个，几秒就完，下一次提问就能查到。
export async function syncStore({ quiet = false } = {}) {
  const say = (s) => {
    if (!quiet) console.log(s);
  };
  const data = loadIndex();
  if (!data || !Array.isArray(data.items)) return await buildIndex({ quiet });

  const recs = collectStore();
  const want = new Map(recs.map((r) => [r.id, r]));
  const kept = [];
  const toEncode = [];
  let removed = 0;
  let reused = 0;
  for (const it of data.items) {
    if (!String(it.id ?? "").startsWith("store:")) {
      kept.push(it);
      continue;
    }
    const rec = want.get(it.id);
    if (!rec) {
      removed++;
      continue;
    }
    if (rec.hash === it.hash && it.vec) {
      kept.push(it); // 没改，原样留着
      reused++;
    } else {
      kept.push({ ...it, ...rec, vec: undefined }); // 文字变了，占位等重编码
      toEncode.push({ ...rec });
    }
    want.delete(it.id);
  }
  for (const rec of want.values()) toEncode.push({ ...rec });

  const encoded = [];
  const BATCH = 16;
  for (let i = 0; i < toEncode.length; i += BATCH) {
    const batch = toEncode.slice(i, i + BATCH);
    const { rows } = await encode(batch.map((x) => x.text));
    batch.forEach((rec, j) => {
      encoded.push({
        id: rec.id,
        sid: rec.sid,
        scope: rec.scope,
        src: rec.src,
        day: rec.day,
        text: rec.text,
        hash: rec.hash,
        vec: Buffer.from(rows[j].buffer, rows[j].byteOffset, rows[j].byteLength).toString("base64"),
      });
    });
  }

  // 用重编码结果替换掉占位项（同 id），避免重复
  const byId = new Map(encoded.map((e) => [e.id, e]));
  const finalItems = kept
    .filter((it) => !(String(it.id ?? "").startsWith("store:") && !it.vec && byId.has(it.id)))
    .map((it) => byId.get(it.id) ?? it);
  for (const e of encoded) if (!finalItems.some((x) => x.id === e.id)) finalItems.push(e);

  const out = {
    model: data.model,
    dim: data.dim,
    builtAt: data.builtAt,
    syncedAt: new Date().toISOString(),
    count: finalItems.length,
    items: finalItems,
  };
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const tmp = INDEX_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(out), "utf8");
  fs.renameSync(tmp, INDEX_FILE);
  say(
    `记忆库同步：新增/改 ${encoded.length} 条，沿用 ${reused} 条，删 ${removed} 条，总 ${finalItems.length} 块`,
  );
  return { added: encoded.length, reused, removed, total: finalItems.length };
}

// ---------- 关键词退路 ----------
// 向量分不够的时候，同一批块再按词面翻一遍：中文切二字词、英文数字连着的词，BM25 算分。
// 不花钱、不占显存，纯字符串比对。词面完全不重合的句子它也找不出来——找不出来就空着，不硬凑。
const KW_STOP_WORDS = [
  "哪些", "什么", "怎么", "怎样", "哪个", "这个", "那个", "这些", "那些",
  "一下", "可以", "是不", "不是", "有没", "没有", "我们", "你们", "他们",
  "多少", "为什么", "是不是", "有没有", "记得", "记不", "还记", "刚才",
];
const KW_QUESTION_CHARS = /[吗呢吧啊么哪怎什谁啥]/;

function kwTerms(q) {
  let s = String(q ?? "").toLowerCase().replace(/\[cq:[^\]]*\]/g, " ");
  for (const w of KW_STOP_WORDS) s = s.split(w).join(" ");
  const terms = new Set();
  for (const m of s.matchAll(/[a-z][a-z0-9._-]{1,}/g)) terms.add(m[0]);
  for (const m of s.matchAll(/[\u4e00-\u9fa5]+/g)) {
    const run = m[0];
    if (run.length === 1) {
      if (!KW_QUESTION_CHARS.test(run)) terms.add(run);
      continue;
    }
    for (let i = 0; i + 2 <= run.length; i++) {
      const bi = run.slice(i, i + 2);
      if (KW_QUESTION_CHARS.test(bi)) continue; // 「过哪」这种跨着问句切出来的别要
      terms.add(bi);
    }
  }
  return [...terms];
}

function keywordSearch(q, pool, { topK = 3, minMatched = 2, minScore = 1.2 } = {}) {
  const terms = kwTerms(q);
  if (!terms.length || !pool.length) return [];
  const N = pool.length;
  const docs = pool.map((it) => ({ it, text: String(it.text ?? "").toLowerCase() }));
  let totalLen = 0;
  const df = new Map();
  for (const d of docs) {
    totalLen += d.text.length;
    const seen = new Set();
    for (const t of terms) if (d.text.includes(t)) seen.add(t);
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgdl = totalLen / Math.max(1, N);
  const k1 = 1.2;
  const bb = 0.75;
  const idf = new Map();
  for (const t of terms) {
    const d = df.get(t) ?? 0;
    idf.set(t, Math.log(1 + (N - d + 0.5) / (d + 0.5)));
  }
  const need = Math.min(minMatched, terms.length);
  const out = [];
  for (const d of docs) {
    const dl = d.text.length || 1;
    let score = 0;
    let matched = 0;
    for (const t of terms) {
      if (!df.get(t)) continue;
      let tf = 0;
      let from = 0;
      for (;;) {
        const idx = d.text.indexOf(t, from);
        if (idx < 0) break;
        tf++;
        from = idx + t.length;
        if (tf >= 20) break;
      }
      if (!tf) continue;
      matched++;
      score += (idf.get(t) * (tf * (k1 + 1))) / (tf + k1 * (1 - bb + (bb * dl) / avgdl));
    }
    if (matched >= need && score >= minScore)
      out.push({ score, text: d.it.text, src: d.it.src, day: d.it.day, via: "keyword", matched });
  }
  out.sort((x, y) => y.score - x.score);
  return out.slice(0, topK);
}

// ---------- 查询 ----------

let cache = null; // {mtimeMs, data}
function loadIndex() {
  try {
    const st = fs.statSync(INDEX_FILE);
    if (cache && cache.mtimeMs === st.mtimeMs) return cache.data;
    const data = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
    cache = { mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

// scope: 当前会话键（private:xxx / group:xxx）。
// 全解开：opts.open=true 时所有会话的块都进候选，群聊也能想起私聊和别的群；
// 默认还是各看各的（私聊能看 shared 的档案页和日记，群聊只看本群）。
export async function search(
  query,
  { scope = "private", topK = 3, minScore = 0.45, keywordFallback = true, open = false } = {},
) {
  const q = String(query ?? "").trim();
  if (q.length < 4) return [];
  const data = loadIndex();
  if (!data || !data.items?.length) return [];
  // 全解开：不再按会话筛，索引里所有块都进候选
  const allowed = new Set([scope]);
  if (!open) {
    if (!String(scope).startsWith("group:")) {
      allowed.add("shared"); // 档案五页
      allowed.add("private"); // 日记
    }
  }
  const pool = open ? data.items : data.items.filter((it) => allowed.has(it.scope));
  if (!pool.length) return [];
  const { rows } = await encode([QUERY_PREFIX + q]);
  const qv = rows[0];
  const scored = [];
  for (const it of pool) {
    const buf = Buffer.from(it.vec, "base64");
    const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const s = dot(qv, v);
    if (s >= minScore)
      scored.push({ score: s, text: it.text, src: it.src, day: it.day, via: "vector" });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length) return scored.slice(0, topK);
  // 向量一条都没够分：退一步按词面找同一批块，跟翻笔记一个路子
  if (!keywordFallback) return [];
  return keywordSearch(q, pool, { topK });
}

// ---------- 命令行 ----------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv[2] ?? "build";
  if (cmd === "build") {
    await buildIndex();
    process.exit(0);
  }
  if (cmd === "sync") {
    await syncStore();
    process.exit(0);
  }
  if (cmd === "query") {
    const q = process.argv[3] ?? "";
    const scope = process.argv[4] ?? "shared";
    const hits = await search(q, { scope, topK: 5, minScore: 0.3 });
    console.log(`问：${q}（范围 ${scope}）`);
    if (!hits.length) console.log("  没有够像的");
    for (const h of hits) console.log(`  ${h.score.toFixed(3)}  [${h.src}] ${h.text.replace(/\n/g, " / ").slice(0, 110)}`);
    process.exit(0);
  }
  if (cmd === "kw") {
    const q = process.argv[3] ?? "";
    const scope = process.argv[4] ?? "shared";
    const data = loadIndex();
    const allowed = new Set([scope, "shared", "private"]);
    if (String(scope).startsWith("group:")) {
      allowed.clear();
      allowed.add(scope);
    }
    const pool = (data?.items ?? []).filter((it) => allowed.has(it.scope));
    console.log(`词面：${kwTerms(q).join(" / ") || "（没有可用的词）"}`);
    const hits = keywordSearch(q, pool, { topK: 5 });
    if (!hits.length) console.log("  没有词面对得上的");
    for (const h of hits)
      console.log(
        `  ${h.score.toFixed(2)}  [${h.src}] ${String(h.text).replace(/\n/g, " / ").slice(0, 110)}`,
      );
    process.exit(0);
  }
  if (cmd === "stats") {
    const data = loadIndex();
    if (!data) {
      console.log("还没有索引");
      process.exit(0);
    }
    const byScope = {};
    for (const it of data.items) byScope[it.scope] = (byScope[it.scope] ?? 0) + 1;
    console.log(
      `模型 ${data.model} ${data.dim}维，${data.count} 条，建于 ${data.builtAt}，文件 ${(fs.statSync(INDEX_FILE).size / 1048576).toFixed(1)}MB`,
    );
    for (const [k, v] of Object.entries(byScope)) console.log(`  ${k}: ${v}`);
    process.exit(0);
  }
  console.log("用法：build | query \"问题\" [scope] | stats");
}
