// 观澜的本地向量记忆（2026-10-20 晚上主人拍板「开始吧」）
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
import {
  entitiesIn,
  entityScore,
  initEntityTerms,
  entityDf,
  ENT_DF_MAX,
} from "./entity-terms.mjs";

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
const DIARY_DIR = path.join(HOME, "哦鲸鲸的窝");
const ARCHIVE_DIR = path.join(HOME, "archive");
const DAYS_DIR = path.join(ARCHIVE_DIR, "days");
// bge 官方建议：短查询前面加这句，检索更准；存进索引的正文不加。
const QUERY_PREFIX = "为这个句子生成表示以用于检索相关文章：";
const CHUNK_CHARS = 260;
// 2026-10-26 加：库条目（尤其「当天小结」那种）超过这个字数就切开再编码。
// 原因：库里最长的一千二百字，一个人一天几十件事全挤在一个向量里，
// 问其中一件，相似度被另外几十件平均掉——实测问「key 尾号」捞不到那条自己，
// 反倒捞上来一句只谈 key 露出来的闲话。
const SPLIT_MAX = 320;
// 文字块合并的天花板（原来写 CHUNK_CHARS*2=520，太肥，一段话能塞三四件事）
const CHUNK_MERGE = 360;
const MAX_ITEMS_PER_SOURCE = 4000;

// 实体表的加载（2026-10-23）：第一次用到时读一次，读不到也不拦检索
let entReady = false;
function ensureEntities() {
  if (entReady) return;
  entReady = true;
  try {
    initEntityTerms(HOME);
  } catch {
    /* 词表读不到就只用向量+词面两路 */
  }
}

// 实体的 df（出现在多少个索引块里）——决定它能当锁还是不能。
// 表本身在 entity-terms.mjs 里算（挂链也用同一份，别各算各的），这里只是取一下：
// ENT_DF_MAX=48 是实测定的阀，df 比它高的（主人 534 / 余额 438 / 提示词 182 / 重启 173）
// 拿来做信号只会往哪里都沾。
function entDf(term) {
  return entityDf().get(term) ?? 0;
}

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

// 大字块切开（2026-10-26 加的）：库条目不是切出来的、是整条塞进来的，
// 「当天小结」动辄一千二百字，一块里几十件事，向量被平均成一锅粥。
// 切法：先按行分，行太长再按句子分，小段并回去凑到接近 max，不留二十字一句的碎片。
// 注意**不加前缀、不做重叠**：这些块正文里本来就带时间和「〔源：…〕」，够它自己说明白。
function splitLongText(text, max = SPLIT_MAX) {
  const t = String(text ?? "").trim();
  if (t.length <= max) return t ? [t] : [];
  const units = [];
  for (const line of t.split(/\n+/)) {
    const s = line.trim();
    if (!s) continue;
    if (s.length <= max) {
      units.push(s);
      continue;
    }
    let buf = "";
    for (const sent of s.split(/(?<=[。！？；!?;])/)) {
      if (!sent) continue;
      if (buf && (buf + sent).length > max) {
        units.push(buf);
        buf = "";
      }
      buf = buf ? buf + sent : sent;
    }
    if (buf.trim()) units.push(buf.trim());
  }
  const out = [];
  let cur = "";
  for (const u of units) {
    if (!cur) {
      cur = u;
    } else if (cur.length + 1 + u.length <= max) {
      cur = cur + "\n" + u;
    } else {
      out.push(cur);
      cur = u;
    }
  }
  if (cur) out.push(cur);
  return out;
}

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
    if (cur && (cur + "\n" + b).length > CHUNK_MERGE) flush();
    if (b.length <= CHUNK_MERGE) {
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
  // 碎块并回去：几十字一块单独编码，向量跟谁都不像，却容易跟随便什么问句凑个中等分（纯噪声）
  const merged = [];
  for (const c of chunks) {
    if (merged.length && c.length < 60 && merged[merged.length - 1].length + c.length + 1 <= CHUNK_MERGE) {
      merged[merged.length - 1] = merged[merged.length - 1] + "\n" + c;
    } else {
      merged.push(c);
    }
  }
  return merged;
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
    // ⚠️ 2026-10-24 修（B7）：**一张卡一块**，不再把多张卡挤进 260 字里。
    for (const f of files.slice(0, MAX_ITEMS_PER_SOURCE)) {
      const body = readText(path.join(dir, f)).trim();
      if (!body) continue;
      // 原因：事件卡讲的是一件独立的事（"他今天说要换工作"），
      // 几张不相关的卡塞成一块后，向量和 BM25 都会被稀释
      // ——实测问「观澜的语音」会捞到「太白喵猫娘」那种卡，就是被同块里别的卡带上来的。
      // 单卡超长时再按 CHUNK_CHARS 硬切，保证不会出现巨型块。
      const parts = [];
      if (body.length <= CHUNK_CHARS) parts.push(body);
      else {
        // 按句子边界尽量切，切不整齐就直接按字数切
        let rest = body;
        while (rest.length > CHUNK_CHARS) {
          let cut = CHUNK_CHARS;
          const window = rest.slice(0, CHUNK_CHARS + 40);
          const m = window.match(/[\s\S]*[。！？\n]/);
          if (m && m[0].length > CHUNK_CHARS * 0.5) cut = m[0].length;
          parts.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut);
        }
        if (rest.trim()) parts.push(rest.trim());
      }
      for (const p of parts) if (p) out.push({ day, text: p });
    }
  }
  return out;
}

// 原话底账：两三句并成一块（块太大就被无关的话稀释，查不准），带日期
const RAW_TALK_GAP_MS = 20 * 60 * 1000; // 话题断了二十分钟以上就另起一块
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
  let curLastTs = 0;
  const flush = () => {
    if (!cur.length) return;
    out.push({
      day: curDay,
      text: cur.join("\n"),
    });
    cur = [];
    size = 0;
    curLastTs = 0;
  };
  for (const r of recs) {
    const day = r.ts
      ? new Date(r.ts + 8 * 3600 * 1000).toISOString().slice(0, 10)
      : "";
    const line = `${r.role === "me" ? "我" : "对方"}：${String(r.text).slice(0, 300)}`;
    // 2026-10-26 加：中间断了二十分钟以上就断开，别把上一场和这一场拼进同一块。
    // 实测私聊连着的两句话有 4% 隔了二十分钟以上（最长十一小时），
    // 拼一起的那几十块问什么都会被另一半拖着。
    const gapMs = cur.length && curLastTs ? r.ts - curLastTs : 0;
    // 换天、话题断了、块满、句数到上限，都断开
    if (
      cur.length &&
      (day !== curDay || gapMs > RAW_TALK_GAP_MS || size + line.length > maxChars || cur.length >= step)
    )
      flush();
    if (!cur.length) curDay = day;
    cur.push(line);
    size += line.length;
    curLastTs = r.ts || 0;
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
    // 时间推理（2026-10-24 主人要的）：原来这里把 superseded 直接丢掉，
    // 于是「你上个月说过的那个」永远翻不到——历史版本连向量都没有，检索无从谈起。
    // 现在**不丢，只打标**：进索引时带 st:"superseded"，检索侧默认剔除、
    // 问句明确指向过去时才放行（见 pickWithHistory）。
    if (!it || it.status === "cold") continue; // 冷藏的仍然不进索引（它本来就不该被想起来）
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
    // 被顶掉的旧版正文后面缀一句「（已过时）」——不光是标签，正文里也让人一眼看出
    // 这是老说法。检索命中这类块时，模型看到这行就不会把它当现状回答。
    const isSuper = it.status === "superseded";
    // 2026-10-26：整条大字块切开再进索引（见 splitLongText 上面那段注释）。
    // id 加 #pN 后缀保证唯一；sid 仍然是**原条目 id**，
    // 检索侧的 superseded / links / 记忆分全靠 sid 回查 store.json，切开不影响。
    const parts = splitLongText(text);
    parts.forEach((part, i) => {
      out.push({
        id: "store:" + it.id + (parts.length > 1 ? "#p" + (i + 1) : ""),
        sid: it.id,
        scope,
        st: isSuper ? "superseded" : "active",
        src: `${where}记忆/${LAYER_LABEL[it.layer] ?? it.layer ?? "记忆"}`,
        day: it.day || "",
        text: part,
        hash: hashText(part),
      });
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
  let storeSuperseded = 0;
  for (const it of collectStore()) {
    // ⚠️ 加字段必须**两处都改**（2026-10-24 栽过一次）：
    //   ①这里把 collectStore() 的产物转手进 items 时要带上；
    //   ②下面 `items.map(...)` 序列化写盘时也要带上。
    // 漏一处就等于没加，而且不报错——索引里查 st 恒为 undefined。
    items.push({
      scope: it.scope,
      src: it.src,
      day: it.day,
      text: it.text,
      id: it.id,
      sid: it.sid,
      hash: it.hash,
      st: it.st ?? "active",
    });
    storeItems++;
    if (it.st === "superseded") storeSuperseded++;
  }
  if (storeItems)
    say(
      `记忆库 ${storeItems} 条也进索引` +
        (storeSuperseded ? `（其中旧版 ${storeSuperseded} 条带 st=superseded）` : ""),
    );

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
  // ⚠️ 2026-10-24 修：原来直接 writeFileSync 覆盖 INDEX_FILE，
  // 写到一半崩/断电会留下半截 JSON（readJson 容错会当没索引，整库检索全废）。
  // 改成和 syncStore 一样的 tmp + rename 原子替换。
  {
    const tmp = INDEX_FILE + ".build.tmp";
    fs.writeFileSync(tmp, JSON.stringify(out), "utf8");
    fs.renameSync(tmp, INDEX_FILE);
  }
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

// ---------- 关键词退路（2026-10-21 下午，主人说「你试试」） ----------
// 向量分不够的时候，同一批块再按词面翻一遍：中文切二字词、英文数字连着的词，BM25 算分。
// 不花钱、不占显存，纯字符串比对。词面完全不重合的句子它也找不出来——找不出来就空着，不硬凑。
const KW_STOP_WORDS = [
  "哪些", "什么", "怎么", "怎样", "哪个", "这个", "那个", "这些", "那些",
  "一下", "可以", "是不", "不是", "有没", "没有", "我们", "你们", "他们",
  "多少", "为什么", "是不是", "有没有", "记得", "记不", "还记", "刚才",
];
const KW_QUESTION_CHARS = /[吗呢吧啊么哪怎什谁啥]/;
// 2026-10-24 加（B2）：命中的关键词要覆盖全部关键词 idf 的至少这个比例才算真的"压中了"。
// 取 0.45：短问句里高频 bigram（观澜/澜的）自己撑不到 45%，必须带上真关键词；
// 长问句命中多个词时很容易过，不会误伤。可用 WW_KW_IDF_COVER 覆盖。
const KW_IDF_COVER = (() => {
  const v = Number(process.env.WW_KW_IDF_COVER);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.45;
})();

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

function keywordSearch(q, pool, { topK = 3, minMatched = 2, minScore = 1.2, all = false, strict = false } = {}) {
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
  // ⚠️ 2026-10-24 修（B2 最终）：早期版本用「命中 idf 合计 / 全部 idf 合计 ≥ 45%」当门槛，
  // 实测发现**单块根本达不到**：一句「观澜的语音是怎么弄的」6 个 bigram 的 idf 合计 33.97，
  // 45% 就是 15.29，而单个块最多命中 2-3 个词（拿到 14 左右就到顶了）——于是整条词面路全灭。
  // 改成「命中"核心词"（idf 最高的那一档，df>0 的才算）**且**条数够」：
  //   相关问句会在那个关键 bigram 上命中（如「语音/音是」），无关问句命中不了。
  // strict 模式（只给退路用）额外要求核心词，主路不强制（主路靠条数+分数）。
  const need = Math.min(minMatched, terms.length);
  const idfSorted = [...idf.entries()].filter(([t, v]) => v > 0 && (df.get(t) ?? 0) > 0).sort((a, b) => b[1] - a[1]);
  const topIdf = idfSorted.length ? idfSorted[0][1] : 0;
  // 核心词 = idf 在最高档 75% 以上的那些（比 85% 宽一点，避免只有一个词够格时过严）
  const coreTerms = new Set(idfSorted.filter(([, v]) => v >= topIdf * 0.75).map(([k]) => k));
  if (coreTerms.size === 0) return [];
  const out = [];
  for (const d of docs) {
    const dl = d.text.length || 1;
    let score = 0;
    let matched = 0;
    let idfHit = 0; // 保留占位（下面评分已在别处算，这里只统计核心词命中）
    let coreHit = false; // 是否命中了核心词
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
      idfHit += idf.get(t);
      if (coreTerms.has(t)) coreHit = true;
      score += (idf.get(t) * (tf * (k1 + 1))) / (tf + k1 * (1 - bb + (bb * dl) / avgdl));
    }
    // 两道门：①命中条数够 ②strict 模式下还要求命中核心词
    //   strict 只给"词面退路"用（一路都没够着门槛时），主路不强制核心词——
    //   主路已经有三道门槛（sim / kw / ent）把关，再叠核心词会把正常召回也砍掉。
    const strictOk = strict ? coreHit : true;
    if (matched >= need && strictOk && score >= minScore)
      out.push({ it: d.it, score, text: d.it.text, src: d.it.src, day: d.it.day, via: "keyword", matched });
  }
  out.sort((x, y) => y.score - x.score);
  return all ? out : out.slice(0, topK);
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
// 2026-10-22 主人要的「全解开」：opts.open=true 时所有会话的块都进候选，群聊也能想起私聊和别的群；
// 默认还是各看各的（私聊能看 shared 的档案页和日记，群聊只看本群）。
//
// 2026-10-23 改打分：不再只看余弦取前三。三样加权——
//   文字像不像 0.6（向量 0.75 + 词面 0.25，两样归一化后合成，词面不再是「一条都没有」才用的退路）
//   新近度 0.25（按层给半衰期：短期 2 天、中期 14 天、长期 90 天、永久不过期）
//   记忆分数 0.15（库里那条的 score；不是记忆库里的块给中性的 0.5）
// 检索到一条记忆库条目时，顺手把它挂着 links 的关联条目带出来（最多 2 条）。
//
// 2026-10-23 收门槛（主人点头改的）：词面得压中三处才算数、向量门槛照 minScore 不打九折、
// 老的关键词退路也过同一道关，过不了就返回空——不再拿「两个常见词凑一起」当像。
const HALF_LIFE = { core: 0, long: 90, mid: 14, short: 2 };
const KW_GATE = 3; // 词面至少压中三处（2026-10-23 08:3x 主人点头从四降回三：四太严，自然问句大量捞不到）
// 光靠词面挤进来的，向量还得有这点底：0.25～0.29 那种纯噪声别再顶上来
// ⚠️ 2026-10-24（B5 配套）：KW_FLOOR 从 0.3 提到 0.35。
// 0.3 是相对分时代的遗留值；改成绝对余弦后，实测无关查询的 sim 也能到 0.295~0.336，
// 0.3 拦不住——于是"词面压中3处"这条路成了无关结果的主要入口。
// 提到 0.35：无关查询（0.28~0.34）基本压不进来，相关的（0.30~0.52）仍能过。
const KW_FLOOR = Number(process.env.WW_KW_FLOOR ?? 0.35);
// 实体信号（2026-10-23 加的第三路，对标 Mem0 的 entity linking）：
// 问句里提到的东西（显卡/密钥/白色风车/重启）在块里也出现了，算另一种"像"。
// 提得够全（≥六成）且向量不至于风马牛（≥ENT_FLOOR）就放进来。
// 为什么要它：「她用的是哪张显卡」这种问句，向量和词面都容易滑到聊天闲话上去，
// 但"显卡"这个实体只出现在少数几条里，实体一路算是个硬锁。
// 实体路的三个门槛，都能环境变量覆盖（方便扫档调参，但线上读默认值）。
// 2026-10-23 实测定档：ENT_GATE 取 0.4 —— 0.6 会把「显卡」从 5 条压到 1 条（块里
// 实体多、密度算得低），0.3 与 0.4 结果完全一致，所以取更保守的 0.4，不放到 0.3。
const ENT_GATE = Number(process.env.WW_ENT_GATE ?? 0.4);
// 2026-10-23 从 0.25 提到 0.30：问「她用的是哪张显卡」时，一条向量只有 0.257 的
// 「私聊余额是 90.71」靠实体分混进首位；提到 0.30 它就掉了，正确那条（0.385）升到首条，
// 同一批 8 个实体问句跑下来没有一个掉答案，所以照着收。
const ENT_FLOOR = Number(process.env.WW_ENT_FLOOR ?? 0.3);
// 实体得够稀有才能当锁（2026-10-23 实测后加的）：
// 先试过「只提到一个实体就不启用实体路」，结果把「余额还剩多少」「白色风车是什么」
// 这类该出结果的问句全干掉了；又试过「单实体也启用」，结果问「401 密钥的事」时，
// 档案页只是顺带提到「密钥」就拿到 ent=1 把整页顶到首条。矛盾在“实体有多泛”
// 而不在“几个”：统计了索引 3383 块里每个实体的 df——
//   主人 df=534（谁都沾）、余额 df=438、提示词 df=182、重启 df=173 → 做信号没意义
//   显卡 df=9、白色风车 df=10、分层 df=15、备份 df=60 → 几乎能唯一定位
// 所以照 IDF 来：至少有一个实体的 df ≤ ENT_DF_MAX 才算“够稀有”，才开实体路。
// （ENT_DF_MAX 挪到 entity-terms.mjs 里了：挂链也用同一条线，省得两边跑偏）
const ENT_MIN_Q = 1; // 稀有实体一个就够
// 互联带出来的那条，必须自己跟问句的向量像到这个数才带。
// 这一项比「共享一个词」硬：问「大白饭」时捎来的「命令行修好」向量只有 0.2 出头，挡掉；
// 真有关联的（同一件事的另一半）向量通常在 0.35 以上。
// 2026-10-23 又调（主人说「你再改改试试」）：一条门槛太粗，改成两条，够了任一条就带——
//   甲、跟问句共享至少一个稀罕词，向量 ≥0.30 就行（共享词本身就是「同一件事」的证据）
//   乙、不共享词也行，但向量得硬到 ≥0.42（纯靠「像」说话，就得真像）
// 实测 18 个问句：单一门槛 0.32 会留下「备份到 GitHub → 重启口令」、「我还欠着 → 三张卡里
// 没留底」这种只靠向量凑近的；改双门槛后留下的 2 条都是共享了稀罕词的（欠着 / api）。
const LINK_SIM_MIN = Number(process.env.WW_LINK_SIM_MIN ?? 0.42);
const LINK_SHARED_SIM_MIN = Number(process.env.WW_LINK_SHARED_SIM_MIN ?? 0.3);
// 大杂烩不参与带出：自己体内稀罕实体超过这个数的（当天小结那种 600 多字、
// 什么都聊一句的），什么问句都能沾上，一律不带。
const LINK_DOC_RARE_MAX = Number(process.env.WW_LINK_DOC_RARE_MAX ?? 8);
const ENT_W = 0.2; // 实体在「文字像不像」里的权重（有实体时才拆出来，没有就退回 0.75/0.25）

// 2026-10-24 加（B5）：把「文字像不像」的权重提成具名常量，方便调；数值与原来一致。
// SIM_W 是**绝对余弦**的权重（原来是相对 maxSim 的，那是个 bug）。
const SIM_W = 0.6; // 有实体路时，向量余弦占 0.6
const KW_W = 0.2; // 有实体路时，词面占 0.2
const SIM_W2 = 0.75; // 无实体路时，向量余弦占 0.75
const KW_W2 = 0.25; // 无实体路时，词面占 0.25
// 2026-10-26 加：末尾三路并列时的权重也提成可调（默认值跟原来一模一样，没改行为）。
// 为什么：原来写死在公式里，想试「新近是不是压过了相关」就得改代码再重建，
// 现在能用环境变量扫一遍、同一份索引比高低。0.6/0.25/0.15 → 文字/新近/记忆分。
const FUSE_TEXT = Number(process.env.WW_FUSE_TEXT ?? 0.6);
const FUSE_REC = Number(process.env.WW_FUSE_REC ?? 0.25);
const FUSE_IMP = Number(process.env.WW_FUSE_IMP ?? 0.15);

// ---------- 记忆来源置信（2026-10-27 加；对照 BioCore 的 _BASE_CONFIDENCE） ----------
// 为什么加：库里**早就有** `source`（ledger/extract/consolidate/short/own-thought）
// 和 `citeKind`（card/raw/mixed/none/owner-ok）两个字段，写了、存了，
// 但 `grep -c "source\|citeKind" vector-memory.mjs` = **0** —— 检索从来没读过它们。
// 后果不是「检索不准」，是**她把自己想出来的、听来的，当成自己亲眼见过的**说出去。
// （她自己都写过这条：「档案里写得最满的那几天，我反而最容易把听来的事说成自己见过的」。）
//
// 设计上刻意**只做轻微修正**：最大 10%，绝不推翻现有的文字/新近/记忆分三路融合。
// 理由是这几路权重是 10-23 拿 290 条真实问句校准出来的，加一路就把校准推翻重来，
// 代价远大于收益。所以它只做两件事：
//   ① **打平局**——分数咬得很近时，让「有原话底账的」压过「她自己的念头」；
//   ② **给出置信**——下游（whale-bot 的 vectorBlockFor）据此提醒她「这条记得不太准」。
// 用 WW_FUSE_SRC=0 可以整条关掉。
const FUSE_SRC = Number(process.env.WW_FUSE_SRC ?? 0.1);
// 低于这个置信就在正文前贴一句「记得不太准」，让模型知道这条别当确定的事说。
const CONF_HEDGE = Number(process.env.WW_CONF_HEDGE ?? 0.5);
// 按「这条是怎么来的」给置信。数值参照 BioCore 的六档（direct 0.82 / told 0.62 /
// inferred 0.45 …），但**改成观澜自己已有的取值**，不引入它那套 vocabulary。
const CONF_BY_SOURCE = {
  ledger: 1.0, // 主人原话底账：最硬，就是他说过的
  extract: 0.7, // 从对话里抽出来的要点：已经过一道转述
  short: 0.75, // 当天小结：也是转述，但时间近
  consolidate: 0.7, // 巩固出来的
  "own-thought": 0.3, // 她自己琢磨的：是想法，不是事实
  manual: 0.6,
};
// 按「有没有能指过去的地方」给置信
const CONF_BY_KIND = {
  raw: 1.0, // 指到原话那一行
  card: 0.85, // 指到事件卡（事件卡本身已经是二手的）
  mixed: 0.8,
  "owner-ok": 1.0, // 主人点头认过的
  none: 0.25, // 明确标了「未核实」
  // 2026-10-27（A5）：「指得到」但「对不上」——出处真、结论假的那种。
  // 比 none 还低，但**不归零**：她可能只是把两件事写在同一行，
  // 完全归零等于让这条记忆彻底消失，那比记错更糟。
  mismatch: 0.2,
};
// 没有记忆库条目（没有 sid）的块，只能按它来自哪个目录判：
// 原话底账是原始语料（最硬），日记是她自己写的（软），档案页是汇总（中）。
function confOfSrcPath(src) {
  const s = String(src || "");
  if (/^原话\//.test(s)) return 1.0;
  if (/^事件卡\//.test(s)) return 0.85;
  if (/^档案\//.test(s)) return 0.95;
  if (/^日子账\//.test(s)) return 0.8;
  if (/^日记\//.test(s)) return 0.7;
  return 0.85;
}
// 两样都有就取平均（都很硬才硬）；只有一样就用它；都没有退回路径判断。
function confOf(it, st) {
  if (st) {
    const s = CONF_BY_SOURCE[st.source];
    const k = CONF_BY_KIND[st.citeKind];
    if (s != null && k != null) return (s + k) / 2;
    if (s != null) return s;
    if (k != null) return k;
  }
  return confOfSrcPath(it?.src);
}
// 2026-10-24 加（B8）：问句里只有人名/高频词（df > ENT_DF_MAX）时，实体路的权重打折。
// 人名 df 天然极高（主人 530 / 〔主人名〕 850），不能当"锁"，但也不该完全不用。
const ENT_WEAK_RATIO = Number(process.env.WW_ENT_WEAK_RATIO ?? 0.5);

function layerOfSrc(src) {
  const m = /记忆\/(永久|长期|中期|短期)/.exec(String(src || ""));
  if (m) return { 永久: "core", 长期: "long", 中期: "mid", 短期: "short" }[m[1]];
  if (/^档案\//.test(src)) return "core";
  if (/^日记\//.test(src)) return "long";
  if (/^原话\//.test(src)) return "short";
  return "mid"; // 事件卡、日子账
}

function recencyOf(day, layer) {
  const hl = HALF_LIFE[layer];
  if (hl === 0) return 1; // 永久层不过期
  const t = Date.parse(day ? `${day}T12:00:00+08:00` : "");
  if (!Number.isFinite(t)) return 0.5; // 没日期：给个中性值，别当成今天
  const days = Math.max(0, (Date.now() - t) / 86400000);
  return Math.pow(0.5, days / (hl || 30));
}

// 记忆库的分数 / 层 / 互联：store.json 改了（mtime 变）再重读，平时吃缓存。
let storeCache = { mtime: 0, byId: null };
function storeInfo() {
  try {
    const st = fs.statSync(STORE_FILE);
    if (storeCache.byId && storeCache.mtime === st.mtimeMs) return storeCache.byId;
    const o = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    const byId = new Map();
    for (const it of o.items ?? []) if (it?.id) byId.set(it.id, it);
    storeCache = { mtime: st.mtimeMs, byId };
    return byId;
  } catch {
    return storeCache.byId || new Map();
  }
}

// ---------- 时间推理：这句是不是在问「过去」（2026-10-24 主人要的） ----------
// 为什么需要：记忆里同一件事会留多代（新的来了旧的标 superseded），
// 但检索默认只认"现在的说法"。于是「你上个月说过什么」「以前是怎么办的」这种问句，
// 永远只能拿到现状答案——答非所问，而且她察觉不到自己漏了历史。
//
// 判据只用**本地词表**，不调模型：
//   一级（wantsHistory）：明确指向过去的时间词/问法 → 放行 superseded，并降权 + 打标；
//   二级（asOf）：能解析出具体日期/月份的，留给未来做快照过滤（这版先只识别不实现）。
//
// ⚠️ 误判代价不对称：把"现在的问题"误判成"问过去"，只是多带了两条打了「已过时」标的老话；
//    反过来（漏判）就会答非所问。所以词表**宁宽勿严**。
const HISTORY_WORDS = [
  "以前", "之前", "早先", "原来", "当初", "当时", "曾经", "过去",
  "上次", "上回", "上一版", "旧版", "老规矩", "老办法", "从前", "那年", "那时候",
  "改过", "改成了", "换成了", "原来不是", "最早", "一开始", "最初",
  "上个月", "上周", "去年", "前天", "前几天", "前几天说", "以前说",
];
// 明确指向"外部世界的历史/别人家的历史"，不该触发自己记忆的历史检索
const NOT_HISTORY_WORDS = ["很久以前的故事", "历史上", "古代", "昨天看的电影"];
function detectHistoryIntent(q) {
  const s = String(q ?? "");
  if (!s) return false;
  for (const w of NOT_HISTORY_WORDS) {
    // 只在**整句就是在问这个外部话题**时才屏蔽（避免"我以前看过这个历史纪录片"被误屏蔽）
    if (s.trim() === w) return false;
  }
  return HISTORY_WORDS.some((w) => s.includes(w));
}

// ---------- 时间推理二级：asOf 快照（2026-10-26 补，原注释写「先只识别不实现」） ----------
// 一级 wantsHistory 解决的是「要不要放行旧版本」；二级 asOf 解决的是「**要哪一天的**」。
// 场景实测：问「前天晚上我说了什么」——一级只会把 superseded 放行，但排出来的仍是**最近**的块，
// 前天那批可能排在 20 名开外，等于没答到点上。
//
// 判据：从问句里解析出**相对日期**，得到目标日期；然后把「日期离目标明显更远」的块降权。
// 只做相对词（昨天/前天/大前天/N天前/上周X/上个月），**不解析绝对日期**——
// 绝对日期（"10月23日"）在她语料里极少出现，做了也是低频路径，不如先把高频的做对。
// 三条保守设计：
//   ① **只降权、不排除**——解析错了顶多排序没变好，不会把正确答案完全踢出去；
//   ② **降权幅度有限**（0.55），保证它仍可能被选中；
//   ③ **解析不出就返回 null**，整条逻辑不生效（零行为变化）。
const AS_OF_REL = [
  [/(?:大前天)/, 3],
  [/(?:前天)/, 2],
  [/(?:昨天|昨日)/, 1],
  [/(\d{1,2})\s*天前/, 0], // 特殊：用捕获的数字
  [/(?:今天|今日|刚才|刚刚)/, 0],
];
/**
 * 解析问句里的「相对日期」，返回 YYYY-MM-DD；解析不出返回 null。
 * @param {string} q 用户问句
 * @param {number} nowMs 当前时间戳（默认现在）
 */
export function parseAsOf(q, nowMs = Date.now()) {
  const s = String(q ?? "");
  if (!s) return null;
  const dayOf = (ts) => {
    const d = new Date(ts + 8 * 3600 * 1000 - 4 * 3600 * 1000); // 与换日线（凌晨四点）一致
    return d.toISOString().slice(0, 10);
  };
  // 先把「今天/刚才」这类排掉——它们没有历史意义，不该触发日期过滤
  if (/(?:今天|今日|刚才|刚刚|现在)/.test(s)) return null;
  let backDays = null;
  const m = s.match(/(\d{1,2})\s*天前/);
  if (m) backDays = Number(m[1]);
  if (backDays === null) {
    for (const [re, n] of AS_OF_REL) {
      if (n === 0) continue;
      if (re.test(s)) {
        backDays = n;
        break;
      }
    }
  }
  if (backDays === null || !Number.isFinite(backDays) || backDays <= 0) return null;
  if (backDays > 30) return null; // 太远的不做（语料里 30 天前的块本来就少）
  return dayOf(nowMs - backDays * 86400 * 1000);
}
/** 某个块的日期离目标日差几天（块没日期就返回 Infinity = 不做降权）。 */
function dayGapOf(blockDay, targetDay) {
  if (!blockDay || !targetDay) return 0;
  const a = Date.parse(`${blockDay}T12:00:00+08:00`);
  const b = Date.parse(`${targetDay}T12:00:00+08:00`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round(Math.abs(a - b) / 86400000);
}

export async function search(
  query,
  // ⚠️ 2026-10-24（B5 配套）：默认 minScore 从 **0.45 改成 0.26**。
  // 0.45 是「相对分时代」的遗留值——那时向量分是 sim/maxSim，top1 恒为 1.0，0.45 很宽松。
  // B5 改成绝对余弦后，0.45 变成「余弦必须 ≥0.45」，实测**相关问句 top1 只有 0.30~0.52**，
  // 「我还欠你什么没做」top1 sim=0.386 直接过不了、召回为 0。
  // 实测分布：相关 0.303~0.523，无关 0.164~0.211，中间 0.21~0.30 是可分空档；
  // 取 0.26（落在空档里、偏保守），4/4 相关召回、0/3 无关漏进。可用 WW_SIM_MIN 覆盖。
  // 实测分布（**索引重建到 5779 块之后重新校准**）：相关 top1 0.303~0.523，无关 0.281~0.285，
  // 空档只剩 0.285~0.303。取 0.29（空档中点偏上）。可用 WW_SIM_MIN 覆盖。
  {
    scope = "private",
    topK = 3,
    minScore = Number(process.env.WW_SIM_MIN ?? 0.29),
    keywordFallback = true,
    open = false,
    explain = false,
  } = {},
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
  const info = storeInfo();
  // 时间推理（2026-10-24 主人要的）：被顶掉的旧说法怎么处理，取决于**这句在不在问过去**。
  //   ①默认（问现在）：扔掉 superseded——老说法进池只会污染当前答案。
  //   ②问过去（wantsHistory）：**放行**，但只作为"补充"参与，不进主排序（后面乘 0.85 降权），
  //     输出时带「【某个日期的说法，现已改为…】」前缀。
  //   ③冷藏的永远扔——它是分数掉下去的东西，跟"历史版本"是两码事。
  const wantsHistory = detectHistoryIntent(q);
  // asOf 二级（2026-10-26 补）：解析「昨天/前天/3天前」得到目标日，把离目标远的块降权。
  // 解析不出 → null，整条不生效。只降权不排除（解析错顶多排序不变，不会踢掉对的）。
  const asOfDay = parseAsOf(q);
  const live = pool.filter((it) => {
    if (!it.sid) return true;
    const st = info.get(it.sid);
    if (!st) return true;
    if (st.status === "cold") return false;
    if (st.status === "superseded") return wantsHistory; // 只有问过去才放行
    return true;
  });
  if (!live.length) return [];
  const { rows } = await encode([QUERY_PREFIX + q]);
  const qv = rows[0];
  // 问句里的实体（2026-10-23）：提到的东西算一路信号，问句抽不出实体就整路跳过
  ensureEntities();
  const qEnts = entitiesIn(q);
  // 实体路只在问句里至少有一个「够稀有」的实体时才开（df 低的才算锁，见 ENT_DF_MAX 注释）。
  // ⚠️ 2026-10-24 修（B8）：原来只认 df ≤ 48 的"稀罕词"，但**人名 df 天然极高**
  // （实测 主人 530 / 〔主人名〕 850 / 观澜 456 / 〔昵称甲〕 71 / 〔群友乙〕 123），全被挡在门外——
  // 结果问「爸爸那个语音」时人名完全不起作用。
  // 但也不能把线放宽到人名（df 高的当锁就是引噪，这正是当初收紧的理由）。
  // 折中：**允许人名当"弱信号"参与加权，但不当"开路的锁"**：
  //   ①qRare 里的稀罕词照旧开实体路（强）；
  //   ②没有稀罕词、只有人名时，把实体路开成"弱模式"：权重砍半，且不参与 EW 门槛。
  const qRare = qEnts.filter((e) => entDf(e) <= ENT_DF_MAX);
  const qWeak = qEnts.filter((e) => entDf(e) > ENT_DF_MAX);
  const entOn = qRare.length >= ENT_MIN_Q;
  // 弱实体路：只有人名/高频词、没有稀罕词时开，权重打折
  const entWeakOn = !entOn && qWeak.length > 0;
  const entTerms = entOn ? qRare : entWeakOn ? qWeak : [];
  // ⚠️ 2026-10-24 修（她指出）：原来 entWeight 和下面的 ent 各乘了一次 ENT_WEAK_RATIO，
  // 0.5×0.5=0.25，人名权重只剩四分之一，等于白加。现在**只在 ent 这一处打折**。
  const sims = new Map();
  for (const it of live) {
    const buf = Buffer.from(it.vec, "base64");
    const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    sims.set(it, dot(qv, v));
  }
  // 词面分也全算一遍（BM25），跟向量分合成「文字像不像」
  const kwScore = new Map();
  const kwHits = new Map();
  let maxKw = 0;
  for (const h of keywordSearch(q, live, { all: true, minMatched: 2, minScore: 0 })) {
    kwScore.set(h.it, h.score);
    kwHits.set(h.it, h.matched);
    if (h.score > maxKw) maxKw = h.score;
  }
  const scored = [];
  for (const it of live) {
    const sim = sims.get(it) ?? 0;
    const k = kwScore.get(it) ?? 0;
    const kw = kwHits.get(it) ?? 0;
    // 实体分：问句里那几个稀有实体，这条盖住几成（0~1）
    const ent = entTerms.length ? entityScore(entTerms, entitiesIn(it.text)) * (entWeakOn ? ENT_WEAK_RATIO : 1) : 0;
    // 「文字像不像」：向量 + 词面 + 实体三个分项加权。
    // 实体路不开时退回两路。
    // ⚠️ 2026-10-24 修（B5）：原来向量分用 `sim/maxSim`（除以本次池内最高分）——
    // 这会把**池子里最差的那条也抬到接近满分**：不管问什么，总有一条 maxSim，它必然得 1.0，
    // 于是 CTRL 的绝对门槛（sim≥0.38 之类）全部失效，问什么都能返回点什么。
    // 改成**绝对余弦**：gemini/bge 的 embedding 已是归一化向量，dot 就是余弦相似度 ∈ [-1,1]，
    // 直接夹到 [0,1] 用。这样「不像」就是不像，门槛才有意义。
    // 词面 k/maxKw 保留相对归一（BM25 原始分量纲不稳定，没有绝对的"像"可言）。
    let textSim;
    if (entOn) {
      textSim = Math.min(
        1,
        SIM_W * Math.max(0, Math.min(1, sim)) +
          KW_W * (maxKw > 0 ? k / maxKw : 0) +
          ENT_W * ent,
      );
    } else if (entWeakOn) {
      // 弱实体路：只有人名/高频词时，实体分量权重减半。
      // ⚠️ 2026-10-24 修：打折只在这里做**一次**（上面第 785 行算 ent 时已经乘过一次，
      // 原来这里又乘一次变成 0.25，现在这行用 ENT_W 不再重复乘）。
      textSim = Math.min(
        1,
        SIM_W * Math.max(0, Math.min(1, sim)) +
          KW_W * (maxKw > 0 ? k / maxKw : 0) +
          ENT_W * ent,
      );
    } else {
      textSim = Math.min(
        1,
        SIM_W2 * Math.max(0, Math.min(1, sim)) + KW_W2 * (maxKw > 0 ? k / maxKw : 0),
      );
    }
    // 门槛：三道任一过关就进来——
    //  ①向量够得像（minScore）；②词面压中 KW_GATE 处且向量不低于 KW_FLOOR；
    //  ③实体盖住六成以上且向量不低于 ENT_FLOOR（只对**强**实体路生效）
    // ⚠️ 2026-10-24（B5 配套 + 真实校准）：单靠 sim 分不开！
    // 真实分布校准（290 条历史真实问句 + 13 条真实无关）：真实问句 p10=0.411 / p50=0.681；
    // 真实无关落在 0.406~0.454 → SIM_STRONG=0.47 能把无关全清。
    // 注：曾怀疑 0.47 砍掉了「我还欠你什么没做」(0.386) 和「爸爸那个语音」(0.287)，
    // 后经实测确认是**测试时没传 open:true**（只搜了私聊 scope）造成的假象——
    // 用真实参数（open=CFG.memoryOpen）时前者 sim=0.41、后者 sim=0.53，都能正常召回。**无需后门。**
    const SIM_STRONG = Number(process.env.WW_SIM_STRONG ?? 0.47);
    const strongSim = sim >= SIM_STRONG;
    const kwOk = kw >= KW_GATE && sim >= KW_FLOOR;
    const entOk = entOn && ent >= ENT_GATE && sim >= ENT_FLOOR;
    // ⚠️ 2026-10-24 修（她指出「我还欠你什么没做捞不到」后查实）：
    // 原来中段（minScore~SIM_STRONG）**必须**有 kwOk 或 entOk 佐证，两者都没有就直接扔。
    // 但实测这条问句 sim=0.386（已过 p25 水平）、kw 只命中 2 个 bigram（差 1 个到 KW_GATE）——
    // 明明挺像，却因为"词面差一点"被否。
    // 试过放宽到 kw>=2：相关 8/8 全召回，但无关也漏进 4/7（股市/天气/地铁/算法都能凑 2 个 bigram）。
    // 所以**不放宽 kw 条数**，改为：由「sim 更高」来兜——中段的 sim 门槛从 minScore(0.29) 提到 0.35，
    // 同时允许"词面只要命中 1 个稀有词"就佐证（稀有词 = idf 高，比条数更有意义）。
    const weakButSupported =
      sim >= Number(process.env.WW_SIM_MID ?? 0.35) && (kw >= 1 || (entOn && ent >= 0.25));
    if (!(strongSim || weakButSupported)) continue;
    const st = it.sid ? info.get(it.sid) : null;
    const isSup = Boolean(st && st.status === "superseded");
    const conf = confOf(it, st);
    // ⚠️ 问过去时**关掉时间衰减**（2026-10-24 想清楚的一条）：
    // 「你以前用什么模型」这个问题，答案本身就是**旧**的东西——如果还按「越新越好」打分，
    // 那条最该被召回的旧块会同时挨两刀（recency 低 + superseded 降权），
    // 实测就是这样被挤出 top10 的。问历史时"新"不是优点。
    const rec = wantsHistory ? 1.0 : recencyOf(it.day, layerOfSrc(it.src));
    const imp = st ? Math.min(1, Math.max(0, Number(st.score ?? 40) / 100)) : 0.5;
    let fused = Math.min(1, FUSE_TEXT * textSim + FUSE_REC * rec + FUSE_IMP * imp);
    // 来源置信（2026-10-27）：**乘**一个 0.9~1.0 的系数，不做第四路相加。
    // 为什么乘不为什么加：三路权重 0.6/0.25/0.15 加起来正好 1.0，再加一路就得重调全部权重，
    // 等于把 10-23 拿 290 条真实问句做的校准全部作废。乘法只轻微压「她自己的念头/没核实的」，
    // 分数咬得近时才改变顺序，压不动的一条都不动。
    if (FUSE_SRC > 0) fused *= 1 - FUSE_SRC + FUSE_SRC * conf;
    // 被顶掉的旧说法降权 15%，让它排在现状答案后面（问过去时也留这一刀，
    // 但 rec 已经封顶成 1.0 了，实际只挨这一刀，不再双重惩罚）。
    if (isSup) fused *= 0.85;
    // asOf 二级（2026-10-26）：问句带了「昨天/前天/N天前」时，**离目标日越远越降权**。
    // 只降不排除：间隔 ≤1 天不罚；2-3 天 ×0.8；>3 天 ×0.55。解析不出（asOfDay=null）则整条跳过。
    if (asOfDay) {
      const gap = dayGapOf(it.day, asOfDay);
      if (gap > 3) fused *= 0.55;
      else if (gap > 1) fused *= 0.8;
    }
    scored.push({ it, fused, sim, textSim, rec, imp, kw, ent, conf, superseded: isSup });
  }
  if (!scored.length) {
    // 一条都没够着门槛：词面退路也过同一道关（压中 KW_GATE 处、向量不低于 KW_FLOOR），过不了就老实空着。
    if (!keywordFallback) return [];
    if (kwTerms(q).length < KW_GATE) return [];
    const hits = keywordSearch(q, live, { all: true, minMatched: KW_GATE, minScore: 1.2, strict: true })
      .filter((h) => (sims.get(h.it) ?? 0) >= KW_FLOOR)
      .slice(0, topK);
    // ⚠️ 2026-10-24 修（B4）：原来直接吐 `score: h.score`（BM25 原始分，13.5 这种），
    // 跟正常路的 `fused`（0~1）**不是一个量纲**，下游拿它比较/排序全错。
    // 现在换算到 0~1：用这批命中里最高 BM25 分做分母，再乘一个上限系数
    // （退路本来就是"勉强够着"，不给满分，封顶 0.5），保证和 fused 可比。
    const maxHit = hits.reduce((a, h) => Math.max(a, h.score), 0);
    return hits.map((h) => ({
      score: Math.round(Math.min(0.5, (maxHit > 0 ? h.score / maxHit : 0) * 0.5) * 1000) / 1000,
      text: h.text,
      src: h.src,
      day: h.day,
      via: "keyword",
    }));
  }
  scored.sort((a, b) => b.fused - a.fused);
  const top = scored.slice(0, topK);
  const out = top.map((h) => {
    const o = {
      score: Math.round(h.fused * 1000) / 1000,
      text: h.it.text,
      src: h.it.src,
      day: h.it.day,
      via: "fused",
      sim: Math.round(h.sim * 1000) / 1000,
      // 2026-10-27 加：这条有多可信（0~1）。下游据此决定要不要提醒她「记得不太准」。
      conf: Math.round(h.conf * 1000) / 1000,
    };
    // 低置信的块，**在正文前贴一句**（不是只给字段）。
    // 理由和 superseded 前缀同一条：这些块最终是拼进提示词的纯文本，
    // 模型看不到元数据；只有写进正文，它才知道「这条别当确定的事说」。
    if (h.conf < CONF_HEDGE && !h.superseded) {
      o.text = `【这条记得不太准，别当确定的事说】${h.it.text}`;
      o.hedged = true;
    }
    // 时间推理（2026-10-24）：被顶掉的旧说法出结果时，**在正文前面贴一句日期前缀**。
    // 为什么要在正文里写而不是只给个字段：这些块最终是拼进提示词的纯文本，
    // 模型看不到元数据；只有写进正文，它才知道「这是老说法，不是现状」。
    if (h.superseded) {
      const when = h.it.day ? `${h.it.day} ` : "";
      const st2 = h.it.sid ? info.get(h.it.sid) : null;
      const byWho = st2?.supersededBy
        ? (info.get(st2.supersededBy)?.text ?? "").slice(0, 40)
        : "";
      o.text = `【${when}的说法，${byWho ? `现已改为「${byWho}…」` : "现已过时"}】${h.it.text}`;
      o.superseded = true;
    }
    // 调试用：explain 打开时把三样分量也带出来，正常调用不看这些字段
    if (explain)
      o.parts = {
        textSim: Math.round(h.textSim * 1000) / 1000,
        rec: Math.round(h.rec * 1000) / 1000,
        imp: Math.round(h.imp * 1000) / 1000,
        kw: h.kw,
        ent: Math.round((h.ent ?? 0) * 1000) / 1000,
        conf: Math.round((h.conf ?? 0) * 1000) / 1000,
      };
    return o;
  });
  // 互联：命中的记忆库条目顺带把挂着 links 的带出来（最多 2 条）
  // 2026-10-23 收口（主人点头「就按你说的调吧」）：这条链要过三道筛——
  //   ①问句里至少得有一个稀罕词（df ≤ ENT_DF_MAX），没有就不开这条带出通道。
  //     原来是问句抽不出稀罕词时「不过滤、全带」，问「大白饭」就捎来两条八竿子打不着的。
  //   ②它自己得跟问句像：向量相似度（循环里早就算过了，直接拿来用）。
  //     2026-10-23 再调成双门槛：共享稀罕词时 0.30 就够，不共享词得 0.42（见 LINK_SIM_MIN 注释）。
  //     这一条最关键——以前带出来的从头到尾没跟问句比过像不像，只看「有没有同一个词」。
  //   ③不能是「顺手带一句」的大杂烩：体内稀罕实体超过 LINK_DOC_RARE_MAX 的
  //     （645 字那块体内 20 个稀罕词、853 字那块 17 个）什么问句都能沾上，一律不带。
  // 分数压到命中分的 0.75 倍，永远排在正主后头，不抢首条位置。
  const bySid = new Map();
  for (const it of live) if (it.sid) bySid.set(it.sid, it);
  const seen = new Set(out.map((x) => x.text));
  let extra = 0;
  for (const h of top) {
    if (extra >= 2) break;
    if (!qRare.length) break; // 没有稀罕锁：宁可不带
    const st = h.it.sid ? info.get(h.it.sid) : null;
    for (const lid of st?.links || []) {
      if (extra >= 2) break;
      const link = info.get(lid);
      const hit = bySid.get(lid);
      if (!link || !hit || link.status !== "active") continue;
      if (seen.has(hit.text)) continue;
      const hitEnts = entitiesIn(hit.text);
      const hitRare = hitEnts.filter((e) => entDf(e) <= ENT_DF_MAX);
      if (hitRare.length > LINK_DOC_RARE_MAX) continue; // 大杂烩
      const sim = sims.get(hit) ?? 0;
      const sharedRare = qRare.some((e) => hitRare.includes(e));
      // 甲：共享稀罕词 + 向量 0.30；乙：不共享词，但向量得 0.42
      if (!(sim >= LINK_SIM_MIN || (sharedRare && sim >= LINK_SHARED_SIM_MIN))) continue;
      seen.add(hit.text);
      extra++;
      out.push({
        score: Math.round(h.fused * 750) / 1000,
        text: hit.text,
        src: hit.src,
        day: hit.day,
        via: "link",
        sim: Math.round((sims.get(hit) ?? 0) * 1000) / 1000,
      });
    }
  }
  return out;
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
  if (cmd === "history-test") {
    // 时间推理自检（2026-10-24）：验「问现在 / 问过去」的分流是否按预期。
    // 不花模型钱：判词只需本地词表，统计只需读 store.json。
    const cases = [
      ["爸爸那个语音是怎么弄的", false],
      ["现在用的哪个模型", false],
      ["我还欠你什么", false],
      ["你上个月说过什么", true],
      ["以前是怎么办的", true],
      ["原来的规矩是什么", true],
      ["你之前说的那个口令", true],
      ["当初为什么这么定", true],
      ["改过几次", true],
      ["我们最早聊的是什么", true],
      ["上周的进度怎么样", true],
      ["它现在在干嘛", false],
      ["历史上的今天", false],
    ];
    let bad = 0;
    for (const [q, want] of cases) {
      const got = detectHistoryIntent(q);
      const ok = got === want;
      if (!ok) bad++;
      console.log(`${ok ? "对 " : "错 "} ${want ? "应问过去" : "应问现在"} → ${got ? "问过去" : "问现在"}  「${q}」`);
    }
    // 统计库里有多少 superseded 会被 time-travel 用到
    const info = storeInfo();
    let sup = 0;
    let act = 0;
    for (const v of info.values()) {
      if (v.status === "superseded") sup++;
      else if (v.status === "active") act++;
    }
    console.log(`\n库里：active ${act} 条 / superseded ${sup} 条（问过去时可被召回）`);
    const idx = loadIndex();
    const idxSup = (idx?.items ?? []).filter((x) => x.st === "superseded").length;
    console.log(`索引里：带 st=superseded 标记的块 ${idxSup} 个` +
      (sup && !idxSup ? "  ⚠ 库里有旧版但索引里没有——要跑一次 `node vector-memory.mjs build` 重建" : ""));
    console.log(`\n${bad ? `有 ${bad} 条不符合预期` : "全部符合预期"}`);
    process.exit(bad ? 1 : 0);
  }
  if (cmd === "query") {
    const q = process.argv[3] ?? "";
    const scope = process.argv[4] ?? "private:1000000001";
    const hits = await search(q, { scope, topK: 5, minScore: 0.3 });
    console.log(`问：${q}（范围 ${scope}）`);
    if (!hits.length) console.log("  没有够像的");
    for (const h of hits) console.log(`  ${h.score.toFixed(3)}  [${h.src}] ${h.text.replace(/\n/g, " / ").slice(0, 110)}`);
    process.exit(0);
  }
  if (cmd === "kw") {
    const q = process.argv[3] ?? "";
    const scope = process.argv[4] ?? "private:1000000001";
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
