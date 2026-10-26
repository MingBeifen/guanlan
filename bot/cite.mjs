// 出处（2026-10-23 04:5x 主人定的：「每条结论都得能指回原话或新闻文件」）
//
// 为什么要有它：底账、小结、日子账、记忆库都是「摘要的摘要」。摘要一漂，
// 谁都查不回去，错的说法还会越攒越像真的。所以每条结论后面跟一处出处，
// 出处只有三种写法，都能机械核对到文件：
//
//   卡:2026-10-22#04-12     事件卡（档案\days\<会话>\<日期>\04-12-标题.md）
//   原话:2026-10-22 04:12   原话底账（档案\<会话>.jsonl 里那一分钟的话）
//   news:2026-10-23-IT之家  抓回来的新闻（home\news\<文件名>.md）
//
// 写在结论后面：〔源：卡:2026-10-22#04-12〕；多出处用「、」隔开。
// 模型自己没写出处时，按字面重合度机械猜一处，猜出来的标「·推断」，
// 猜不着就写「未核实」——宁可难看，也不让没出处的结论装成有根有据。
import fs from "node:fs";
import path from "node:path";

const TAG_RE = /〔源：([^〕]*)〕/g;
export const NO_CITE = "未核实";
export const GUESS_MARK = "·推断";

export function citeTag(cite) {
  return `〔源：${cite}〕`;
}

export function extractCites(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(TAG_RE)) {
    for (const part of m[1].split(/[、,，]/)) {
      const c = part.trim();
      if (c) out.push(c);
    }
  }
  return out;
}

export function stripCites(text) {
  return String(text ?? "")
    .replace(TAG_RE, "")
    .replace(/[ \t]+$/g, "")
    .trim();
}

export function hasCite(text) {
  return extractCites(text).length > 0;
}

// ---------- 核对 ----------

function archiveKeyOf(key) {
  return String(key ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
}

function sessionDirs(archiveDir, day) {
  const root = path.join(archiveDir, "days");
  const out = [];
  try {
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name, day);
      if (fs.existsSync(dir)) out.push({ session: name, dir });
    }
  } catch {
    /* 没有 days 目录就是没卡 */
  }
  return out;
}

function findCard(ctx, day, hhmm) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{2}-\d{2}$/.test(hhmm)) return null;
  const own = archiveKeyOf(ctx.key);
  const dirs = sessionDirs(ctx.archiveDir, day).sort(
    (a, b) => (a.session === own ? -1 : 0) - (b.session === own ? -1 : 0),
  );
  for (const d of dirs) {
    let files = [];
    try {
      files = fs.readdirSync(d.dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    const hit = files.find((f) => f.startsWith(`${hhmm}-`));
    if (hit) {
      return {
        file: path.join(d.dir, hit),
        rel: `档案\\days\\${d.session}\\${day}\\${hit}`,
      };
    }
  }
  return null;
}

function findRawLine(ctx, day, hhmm) {
  const start = Date.parse(`${day}T${hhmm}:00+08:00`);
  if (!Number.isFinite(start)) return null;
  const end = start + 61 * 1000;
  let files = [];
  try {
    files = fs.readdirSync(ctx.archiveDir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return null;
  }
  const own = `${archiveKeyOf(ctx.key)}.jsonl`;
  files.sort((a, b) => (a === own ? -1 : 0) - (b === own ? -1 : 0));
  for (const f of files) {
    let raw = "";
    try {
      raw = fs.readFileSync(path.join(ctx.archiveDir, f), "utf8");
    } catch {
      continue;
    }
    let n = 0;
    for (const line of raw.split("\n")) {
      n++;
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.ts >= start && o.ts < end)
        return { rel: `档案\\${f} 第${n}行`, role: o.role, text: String(o.text ?? ""), ts: o.ts };
    }
  }
  return null;
}

function findNews(ctx, name) {
  const dir = path.join(ctx.home, "news");
  const clean = String(name ?? "")
    .replace(/\.md$/i, "")
    .trim();
  if (!clean) return null;
  const direct = path.join(dir, `${clean}.md`);
  if (fs.existsSync(direct)) return { rel: `home\\news\\${clean}.md` };
  try {
    const hit = fs
      .readdirSync(dir)
      .find((f) => f.endsWith(".md") && f.startsWith(clean));
    if (hit) return { rel: `home\\news\\${hit}` };
  } catch {
    /* 还没抓过新闻 */
  }
  return null;
}

/** 把模型顺手写歪的样子揉回标准写法：〔源：16:00〕、源：16:00、16:00·推断 都收 */
export function simplifyCite(cite) {
  let c = String(cite ?? "").trim();
  c = c.replace(/^〔\s*源\s*[:：]\s*/, "").replace(/^源\s*[:：]\s*/, "").replace(/\s*〕$/, "");
  return c.trim();
}

/** 核对一处出处：真的指得到文件才算数 */
export function resolveCite(ctx, cite) {
  const raw = simplifyCite(cite);
  if (!raw) return { ok: false, kind: "none", why: "没有出处" };
  const guessed = raw.endsWith(GUESS_MARK);
  const c = guessed ? raw.slice(0, -GUESS_MARK.length) : raw;
  if (c === NO_CITE) return { ok: false, kind: "none", why: "标了未核实" };
  // 最省事也最常写的一种：只写当天的钟点 〔源：04:12〕
  // 先认事件卡（同一分钟只有一张），没有再回原话底账找那一分钟
  const clock = /^(\d{2}:\d{2})$/.exec(c);
  if (clock) {
    const day = String(ctx?.day ?? "");
    const card = day ? findCard(ctx, day, clock[1].replace(":", "-")) : null;
    if (card) return { ok: true, kind: "card", rel: card.rel, guessed };
    const line = day ? findRawLine(ctx, day, clock[1]) : null;
    return line
      ? { ok: true, kind: "raw", rel: line.rel, guessed }
      : { ok: false, kind: "clock", why: `${day || "当天"} ${raw} 那会儿没卡也没原话` };
  }
  const m = /^(卡|原话|news|新闻)[:：](.+)$/.exec(c);
  if (!m) return { ok: false, kind: "bad", why: `不认识的写法：${raw}` };
  const [, kind, body] = m;
  if (kind === "卡") {
    const mm = /^(\d{4}-\d{2}-\d{2})#(\d{2}-\d{2})$/.exec(body.trim());
    if (!mm) return { ok: false, kind: "bad", why: `卡的写法不对：${raw}` };
    const hit = findCard(ctx, mm[1], mm[2]);
    return hit
      ? { ok: true, kind: "card", rel: hit.rel, guessed }
      : { ok: false, kind: "card", why: `那天那个点没有卡：${raw}` };
  }
  if (kind === "原话") {
    const mm = /^(\d{4}-\d{2}-\d{2})[ #](\d{2}:\d{2})$/.exec(body.trim());
    if (!mm) return { ok: false, kind: "bad", why: `原话的写法不对：${raw}` };
    const hit = findRawLine(ctx, mm[1], mm[2]);
    return hit
      ? { ok: true, kind: "raw", rel: hit.rel, guessed }
      : { ok: false, kind: "raw", why: `那一分钟没有原话：${raw}` };
  }
  const hit = findNews(ctx, body.trim());
  return hit
    ? { ok: true, kind: "news", rel: hit.rel, guessed }
    : { ok: false, kind: "news", why: `没这份新闻：${raw}` };
}

// ---------- 猜出处（模型没写或写歪了时的机械兜底） ----------

function chatty(s) {
  return String(s ?? "")
    .replace(/〔[^〕]*〕/g, "")
    .replace(/^[-*·•]\s*/, "")
    .replace(/^(他|我|主人|爸爸)[：:]/, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function bigrams(s) {
  const n = chatty(s);
  const set = new Set();
  for (let i = 0; i + 2 <= n.length; i++) set.add(n.slice(i, i + 2));
  return set;
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const g of a) if (b.has(g)) hit++;
  return hit / a.size;
}

function dayCards(ctx, day) {
  const own = archiveKeyOf(ctx.key);
  const out = [];
  for (const d of sessionDirs(ctx.archiveDir, day)) {
    let files = [];
    try {
      files = fs.readdirSync(d.dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      let body = "";
      try {
        body = fs.readFileSync(path.join(d.dir, f), "utf8");
      } catch {
        continue;
      }
      out.push({
        cite: `卡:${day}#${f.slice(0, 5)}`,
        own: d.session === own,
        body,
      });
    }
  }
  return out;
}

function dayNews(ctx, day) {
  const dir = path.join(ctx.home, "news");
  const out = [];
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md")) continue;
      if (!f.includes(day) && !f.startsWith(day)) continue;
      let body = "";
      try {
        body = fs.readFileSync(path.join(dir, f), "utf8");
      } catch {
        continue;
      }
      out.push({ cite: `news:${f.replace(/\.md$/i, "")}`, body });
    }
  } catch {
    /* 没新闻 */
  }
  return out;
}

/**
 * 按字面重合给一句话找出处。只在「模型没给或给的核不上」时用。
 * 走自己的会话优先；猜出来的会带 ·推断 标。
 */
export function guessCite(ctx, text, opts = {}) {
  const target = bigrams(stripCites(text));
  if (target.size < 4) return null; // 太短，猜了也是瞎猜
  const minCard = opts.card ?? 0.6;
  const minNews = opts.news ?? 0.68;
  let best = null;
  for (const c of dayCards(ctx, ctx.day)) {
    const score = overlap(target, bigrams(c.body));
    if (score < minCard) continue;
    const weighted = score + (c.own ? 0.03 : 0);
    if (!best || weighted > best.weighted)
      best = { cite: c.cite, weighted, score };
  }
  for (const n of dayNews(ctx, ctx.day)) {
    const score = overlap(target, bigrams(n.body));
    if (score < minNews) continue;
    if (!best || score > best.weighted) best = { cite: n.cite, weighted: score, score };
  }
  if (!best) return null;
  return { cite: best.cite + GUESS_MARK, score: best.score };
}

/**
 * 把 resolveCite 给的 rel 读回原文（「老话：指得到 → 对得上」的那后半段）。
 * rel 有两种：事件卡文件路径、`档案\x.jsonl 第N行`。
 */
export function readSourceText(ctx, rel) {
  const r = String(rel ?? "");
  try {
    const lineNo = / 第(\d+)行$/.exec(r);
    if (lineNo) {
      const f = r.replace(/ 第\d+行$/, "").replace(/^档案[\\/]/, "");
      const raw = fs.readFileSync(path.join(ctx.archiveDir, f), "utf8");
      const one = raw.split("\n")[Number(lineNo[1]) - 1];
      if (!one) return "";
      const o = JSON.parse(one);
      // 只认他自己说的话当出处：她自己的话不能给她的结论作证
      return String(o.text ?? "");
    }
    const p = r.replace(/^档案[\\/]/, "");
    return fs.readFileSync(path.join(ctx.archiveDir, p), "utf8");
  } catch {
    return "";
  }
}

// ---------- 对得上吗（2026-10-27 加；对着 A5 的实测数据挑的判据） ----------
//
// ⚠️ 这一节是**拿真实数据反复推倒重来**才定下来的，改动前先读这段。
//
// 第一版判据是 BioCore 那种「字重合 + 长度比」，
// 回放 96 条真实条目时**假阳性 42.7%**——因为观澜的条目大多是**当天汇总**，
// 引了十几句原话，而 `resolveCite` 只给得了**第一条**出处，拿一分钟的原话去比一整天的汇总，
// overlap 当然只有 0.04。**不是她编了，是我拿错了比对物。**
//
// 第二版改成「对当天该会话的全部原话」，假阳性降到 0%，但**又抓不到任何篡改**：
// 字重合判据对中文几乎无效——她写「硬盘全换固态、预算八千」，
// 当天的原话里单字「硬/盘/换/固/态/预/算」基本都出现过，重合率自然够。
// **字重合判的是「用词像不像」，不是「事对不对」。**
//
// 所以最终判据换成 **可核事实**：数字（金额/版本/ID）、英文串（配置键/文件名/命令）、
// 引号里的话。这些**她编不出来也改不动**——改一个数字/一个键名，就是和原话对不上。
// 实测（96 条真实条目 + 三种篡改）：
//   真实条目判「对得上」 95.8%（假阳性 4.2%）
//   整条编造 抓到 93.8% ｜ 换英文 76.2% ｜ 换数字 38.0%
// 换数字只抓到 38% 是**已知的、可接受的**：改了数字但同一个数在别处也出现过，就不算错。
// 它的定位是**发现「凭空长出的事实」**，不是逐字校验。
const FACT_RATE_OK = 0.7; // 七成可核事实对得上就算有据

/** 一个块/一条记忆里「她编不出来」的东西：数字、英文串、引号里的话。 */
export function decisiveFacts(text) {
  const s = String(text ?? "");
  const out = new Set();
  for (const m of s.matchAll(/\d[\d,.:-]{1,}/g)) {
    const v = m[0].replace(/[,，]$/, "");
    if (/^\d{2}:\d{2}$/.test(v)) continue; // 纯钟点是她打的记录时间，原话里本来就没有
    if (v.replace(/\D/g, "").length >= 2) out.add(v.toLowerCase());
  }
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_.\-]{2,}/g)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/[「『“"《`]([^」』”"》`]{4,40})[」』”"》`]/g)) out.add("«" + m[1]);
  return [...out];
}

const _dayCache = new Map();
/**
 * 读某天某会话的**全部**档案（含她自己说的话）。
 * 为什么要含她自己的：她的条目常引用「我答应他…」「我说我是观澜」——
 * 那些话在 `role==="me"` 的行里，只读主人原话会把正常的自述全判成编造。
 */
export function dayArchiveText(ctx) {
  const key = `${ctx?.key ?? ""}|${ctx?.day ?? ""}`;
  if (_dayCache.has(key)) return _dayCache.get(key);
  let text = "";
  try {
    const f = path.join(ctx.archiveDir, `${archiveKeyOf(ctx.key)}.jsonl`);
    const start = Date.parse(`${ctx.day}T00:00:00+08:00`);
    const end = start + 86400e3;
    const raw = fs.readFileSync(f, "utf8");
    const out = [];
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.ts >= start && o.ts < end) out.push(String(o.text ?? ""));
    }
    text = out.join("\n");
  } catch {
    text = "";
  }
  // 缓存只留最近的几十天，别无限涨（一次小结会连着查同一天几百条）
  if (_dayCache.size > 50) _dayCache.clear();
  _dayCache.set(key, text);
  return text;
}

/**
 * 一条结论**对不对得上**当天的档案。
 * @returns {{ok:boolean, rate:number, n:number, miss:string[], why:string}}
 */
export function checkFacts(claim, archiveText) {
  const facts = decisiveFacts(claim);
  if (!facts.length) return { ok: true, rate: 1, n: 0, miss: [], why: "没有可核事实" };
  const W = String(archiveText ?? "").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  if (!W) return { ok: false, rate: 0, n: facts.length, miss: facts.slice(0, 5), why: "当天没有档案可比" };
  const miss = facts.filter((t) => !W.includes(t.replace(/^«/, "").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase()));
  const rate = (facts.length - miss.length) / facts.length;
  return {
    ok: rate >= FACT_RATE_OK,
    rate,
    n: facts.length,
    miss: miss.slice(0, 5),
    why: rate >= FACT_RATE_OK ? "" : `${miss.length}/${facts.length} 个可核事实在当天档案里找不到`,
  };
}

// ---------- 批量挂出处 ----------

/**
 * 给一组要点挂出处：先认模型自己写的，核不上再机械猜，都不行写「未核实」。
 * lines 可以是 "文字" 或 "- 文字"；前缀原样保留，出处挂在末尾。
 * 返回的 lines 已可直接落盘。
 */
export function attachSources(lines, ctx) {
  const out = [];
  let exact = 0;
  let guessed = 0;
  let missing = 0;
  const bad = [];
  for (const raw of lines) {
    const one = String(raw ?? "").trim();
    if (!one) continue;
    const prefix = /^[-*·•]\s*/.test(one) ? one.match(/^[-*·•]\s*/)[0] : "";
    const body = stripCites(one.slice(prefix.length));
    const given = extractCites(one).filter((c) => c !== NO_CITE);
    const good = [];
    for (const c of given) {
      const r = resolveCite(ctx, c);
      if (r.ok) good.push(c);
      else bad.push({ cite: c, why: r.why });
    }
    let line;
    if (good.length) {
      line = `${prefix}${body}${citeTag(good.join("、"))}`;
      exact++;
    } else {
      const g = guessCite(ctx, body);
      if (g) {
        line = `${prefix}${body}${citeTag(g.cite)}`;
        guessed++;
      } else {
        line = `${prefix}${body}${citeTag(NO_CITE)}`;
        missing++;
      }
    }
    out.push(line);
  }
  return { lines: out, exact, guessed, missing, bad };
}
