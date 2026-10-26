// 实体抽取（2026-10-23 加）：给检索加一路「说的人/东西一样」的信号，
// 也给记忆库条目按共享实体挂 links 用。
//
// 为什么不用自举：把这套库里 78 条记忆的中文 2-4 字片段全统计了一遍，
// ≥3 条共现的有 479 个，做最长匹配剪枝还剩 319 个，但里面混着「示词」「能改」
// 「启后」「爸能改」这类被滑窗切碎的残片，还有「群里」「只有」「答应」「让我」
// 这类虚词/动词短语。中文没有词边界，纯频次自举出来的词表有一半是脏的，
// 脏词进了检索会直接把不相关的条目顶上来。所以走「策展词表 + 英文技术词 + 人名表」，
// 跟 Mem0 的 entity linking 是同一个思路（都是词表），但这里词表小而准，命中即可信。
//
// 扩词只改 home\memory\entity-terms.json（跟 names.json 一样，改了重启生效）：
//   { "extra": ["新词1", "新词2"] }
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// 底表：这套系统里真会反复出现的「东西」和「事」。一律 ≥2 字，
// 单字（林、月）不当实体——一个字在中文里到处都是，做检索信号只会引噪。
const BASE = [
  // 人
  "主人", "爸爸", "小宝",
  // 账与钱
  "余额", "扣钱", "花费", "账单", "token",
  // 记忆这套东西本身
  "记忆", "向量", "摘要", "小结", "日记", "档案", "原话", "底账", "雪藏", "冷藏", "淡忘",
  "巩固", "钉住", "分层", "打分", "检索", "召回", "关键词", "语义", "互联",
  // 观澜自己
  "人设", "提示词", "上下文", "人格", "性格", "口吻",
  // 会话与群
  "群聊", "私聊", "白名单", "黑名单", "群号", "QQ号", "艾特", "截图", "昵称",
  // 运行与运维
  "重启", "进程", "配置", "补丁", "备份", "恢复", "开机", "自启", "权限", "完整性",
  "显卡", "显存", "模型", "密钥", "网关", "端口", "面板", "日志", "报错", "崩溃",
  // 规矩与约定
  "口令", "规矩", "承诺", "答应", "欠着", "作息", "问候", "晚安", "睡觉", "起床",
  // 具体物
  "白色风车", "小鲸", "耳机", "屏幕", "桌面壁纸"];

const STOP_EN = new Set([
  "the", "and", "for", "with", "that", "this", "you", "are", "was", "not", "but", "can",
  "has", "have", "had", "will", "would", "should", "could", "from", "they", "them",
  "好", "对", "是", "了", "的"]);

let cache = { terms: BASE, set: new Set(BASE), extraMtime: 0 };
let extraPath = "";
let homeDir = "";

// ---------- 稀罕度（df） ----------
// 一个实体在多少块记忆里出现过，决定它能不能当「锁」（2026-10-23 实测定的）：
//   显卡 9、白色风车 10、分层 15、补丁 4 → 拿它一戳几乎就定位到对应条目；
//   主人 534、余额 438、私聊 439、〔主人名〕 842、提示词 182、重启 173 → 哪儿都沾，当信号就是引噪。
// 所以照 IDF 来：df 比 ENT_DF_MAX 低才算稀罕。线定在 48（整库 3383 块的 1.4%）——
// 再紧一档（≤16）连「备份到 GitHub」都锁不住，松到 128 就把「记忆/重启」放进来了。
export const ENT_DF_MAX = Number(process.env.WW_ENT_DF_MAX ?? 48);

// 语料 = 整个向量索引（档案 + 日记 + 事件卡 + 原话 + 记忆库，三千多块）。
// 不用 store.json 那 70 条来算：那边实体最多的「答应」才 10 条，
// 按 70 条算所有词都稀罕，等于没筛。
let dfCache = { map: null, indexMtime: -1 };

function indexMtime() {
  try {
    return fs.statSync(path.join(homeDir, "memory", "vectors", "index.json")).mtimeMs;
  } catch {
    return -1; // 没索引：拿空表，谁都不砍
  }
}

function dfFile() {
  return path.join(homeDir, "memory", "entity-df.json");
}

// 读缓存的 df 表：索引文件没动过（mtime 一样）就直接用，不必再解析 15MB 的索引
function loadDfCache(mtime) {
  try {
    const o = JSON.parse(fs.readFileSync(dfFile(), "utf8").replace(/^\uFEFF/, ""));
    if (!o?.df || Number(o?.indexMtime) !== Number(mtime)) return null;
    return new Map(Object.entries(o.df));
  } catch {
    return null;
  }
}

// 算 df：索引里每块抽出实体，数各出现在多少块。算完写回小文件，下次启动直接读。
// 索引没有就返回空表——所有实体都按「没出现过」算，也就是都当稀罕处理（保守，先不砍）。
function computeDf() {
  const mtime = indexMtime();
  const cached = loadDfCache(mtime);
  if (cached) return cached;
  const indexFile = path.join(homeDir, "memory", "vectors", "index.json");
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  } catch {
    return new Map();
  }
  const df = new Map();
  for (const it of data?.items || []) {
    const seen = new Set(entitiesIn(it.text));
    for (const e of seen) df.set(e, (df.get(e) || 0) + 1);
  }
  if (data?.builtAt) {
    try {
      fs.writeFileSync(
        dfFile(),
        JSON.stringify({ indexMtime: mtime, builtAt: data.builtAt, count: data?.count ?? 0, df: Object.fromEntries(df) }),
        "utf8",
      );
    } catch {
      /* 写不进去就算，下次再算一遍 */
    }
  }
  return df;
}

// 当前的 df 表（带缓存：索引文件没动过就直接用上次那份）
export function entityDf() {
  const mtime = indexMtime();
  if (dfCache.map && dfCache.indexMtime === mtime) return dfCache.map;
  const map = computeDf();
  dfCache = { map, indexMtime: mtime };
  return map;
}

// 这个词够不够稀罕（够稀罕才能当锁 / 才能拿它挂链）
export function isRareEntity(term, max = ENT_DF_MAX) {
  return (entityDf().get(String(term)) ?? 0) <= max;
}

// 人名表：跟 memory-store 共用 home\memory\names.json，但只取 ≥2 字的
function loadNames() {
  try {
    const arr = JSON.parse(
      fs.readFileSync(path.join(HERE, "names.json"), "utf8").replace(/^\uFEFF/, ""),
    );
    if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter((x) => x.length >= 2);
  } catch {
    /* 没有就算了 */
  }
  return [];
}

function loadExtra() {
  try {
    const st = fs.statSync(extraPath);
    if (!extraPath || cache.extraMtime === st.mtimeMs) return [];
    cache.extraMtime = st.mtimeMs;
    const o = JSON.parse(fs.readFileSync(extraPath, "utf8").replace(/^\uFEFF/, ""));
    const arr = Array.isArray(o?.extra) ? o.extra : [];
    return arr.map((x) => String(x).trim()).filter((x) => x.length >= 2);
  } catch {
    return [];
  }
}

let namesLoaded = false;

export function initEntityTerms(home) {
  homeDir = home;
  extraPath = path.join(home, "memory", "entity-terms.json");
  const extra = loadExtra();
  if (!namesLoaded) {
    cache.terms = [...new Set([...BASE, ...loadNames(), ...extra])];
    cache.set = new Set(cache.terms);
    namesLoaded = true;
  } else if (extra.length) {
    cache.terms = [...new Set([...cache.terms, ...extra])];
    cache.set = new Set(cache.terms);
  }
  return cache.terms.length;
}

// 英文/技术词：整词取，少 3 个字符以下不要（ai/os 这种太短会误撞）
const EN_RE = /[A-Za-z][A-Za-z0-9._-]{2,}/g;

// 从一个字符串里抽实体。返回去重数组（顺序按出现先后）。
// 用 include 而不是分词：中文实体是整串在句子里出现的，不需要切。
export function entitiesIn(text) {
  const s = String(text ?? "");
  if (!s) return [];
  const out = [];
  const seen = new Set();
  for (const t of cache.terms) {
    if (s.includes(t) && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  for (const m of s.matchAll(EN_RE)) {
    const w = m[0].toLowerCase();
    if (w.length < 3 || STOP_EN.has(w) || seen.has(w)) continue;
    // 纯数字附近的小数残片（s.7 这种）不要
    if (/^\.|\d{2,}/.test(w) && !/[a-z]{3,}/.test(w)) continue;
    seen.add(w);
    out.push(w);
  }
  return out;
}

// 两组实体的重合度：问句里的实体被盖住了几成（0~1）。
// 分母用问句侧的实体数——问句提了几个东西，答的那条盖住几个。
export function entityOverlap(qEnts, docEnts) {
  if (!qEnts.length || !docEnts.length) return 0;
  const d = new Set(docEnts);
  let hit = 0;
  for (const e of qEnts) if (d.has(e)) hit++;
  return hit / qEnts.length;
}

// 带精度修正的实体分（2026-10-23 ）+。
// 为什么光看 overlap 不够：问「401 密钥的事」时，档案页只顺带提到一句「密钥」
// 就拿到 ent=1，把整页顶到首条，而真正该出的「新 API 密钥只有我爸能建」反被压下去。
// 档案页那类是超大块，里面裹着几十个实体，「密钥」只是其一；真正的主题块
// 只说到几个实体。所以乘一个精度因子 sqrt(命中数 / 块里实体总数)：
//   档案页 1/40 → 0.16；密钥条目 1/4 → 0.5。两个都是 hit=1，但可信度差三倍。
// 这与 Mem0 的 entity linking 思路一致：实体链接得看实体在文中是主还是客。
export function entityScore(qEnts, docEnts) {
  if (!qEnts.length || !docEnts.length) return 0;
  const d = new Set(docEnts);
  let hit = 0;
  for (const e of qEnts) if (d.has(e)) hit++;
  if (!hit) return 0;
  const overlap = hit / qEnts.length;
  const precision = hit / d.size;
  return overlap * Math.sqrt(precision);
}

export function entityTerms() {
  return cache.terms.slice();
}
