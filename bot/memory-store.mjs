// 机器人记忆库（五层 + 打分 + 淡忘）
//
// 五层：
//   永久 core   —— 人设、规矩、答应的事、定下来的偏好；钉住的、或分数 ≥88；不衰减
//   长期 long   —— 70–87 分；慢慢降温（-0.5/天，最低 55）
//   中期 mid    —— 45–69 分；日子账结出来的要点（-2/天）
//   短期 short  —— 12–44 分；当天小结、临时事（-5/天，跌破 12 就冷藏）
//   工作 working—— 不进库：当前这轮实际拼进提示词的那几块，由机器人落 runtime\memory-last.json 给面板看
//
// 分数是"以后还用不用得上"，不是"这件事当时重不重要"。她自己在夜里给新事实打分，
// 面板上也能手改。分数变了，层跟着变（layerOf）；分数被淡忘压下去，就自然沉到下一层。
//
// 存储：home\memory\store.json（面板和机器人共用，读改写 + rename，热更不用重启）。
import fs from "node:fs";
import path from "node:path";

export const LAYERS = ["core", "long", "mid", "short"];
export const LAYER_LABEL = {
  core: "永久",
  long: "长期",
  mid: "中期",
  short: "短期",
  cold: "冷藏",
  working: "工作记忆",
};

export const DEFAULT_DECAY = {
  core: 0,
  long: 0.5,
  mid: 2,
  short: 5,
  min: { core: 0, long: 55, mid: 20, short: 12 },
  coldBelow: 12,
};

const RATE = { core: 0, long: 0.5, mid: 2, short: 5 };
const FLOOR = { core: 0, long: 55, mid: 20, short: 2 };
const COLD_BELOW = 12;

let storeDir = "";
let storePath = "";

export function initMemoryStore(homeDir) {
  storeDir = path.join(homeDir, "memory");
  storePath = path.join(storeDir, "store.json");
  fs.mkdirSync(storeDir, { recursive: true });
  return storePath;
}

function storeFile() {
  if (!storePath) throw new Error("memory-store 还没 init（先调 initMemoryStore(home)）");
  return storePath;
}

function readStore() {
  const p = storeFile();
  try {
    const raw = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
    const obj = JSON.parse(raw);
    if (Array.isArray(obj?.items)) return obj;
  } catch {
    /* 没有或坏了：从空库起；坏的另存一份别丢 */
    try {
      if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.broken-${Date.now()}`);
    } catch {
      /* ignore */
    }
  }
  return { version: 1, updatedAt: 0, items: [], meta: {} };
}

let seq = 0;
function newId() {
  seq = (seq + 1) % 1000;
  return (
    "m" +
    Date.now().toString(36) +
    seq.toString(36).padStart(2, "0") +
    Math.random().toString(36).slice(2, 5)
  );
}

function normText(t) {
  return String(t ?? "")
    .replace(/\s+/g, " ")
    .replace(/[。．.；;，,、]+$/g, "")
    .trim()
    .toLowerCase();
}

export function layerOf(score, pinned = false) {
  const s = clampScore(score);
  if (pinned || s >= 88) return "core";
  if (s >= 70) return "long";
  if (s >= 45) return "mid";
  if (s >= COLD_BELOW) return "short";
  return "cold";
}

export function clampScore(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return 40;
  return Math.max(1, Math.min(100, v));
}

function normalize(it) {
  const pinned = Boolean(it.pinned);
  let score = clampScore(it.score);
  let layer = pinned ? "core" : it.layer && LAYERS.includes(it.layer) ? it.layer : layerOf(score, pinned);
  // 层和分数对不上时以分数为准（钉住的除外）
  if (!pinned && LAYERS.includes(layer) && it.layerFixed !== true) layer = layerOf(score, false);
  if (layer === "cold" || it.status === "cold") {
    layer = "short";
    it.status = "cold";
  }
  if (it.status !== "cold") it.status = "active";
  const now = Date.now();
  return {
    id: String(it.id || newId()),
    key: String(it.key || "shared"),
    layer,
    layerFixed: Boolean(it.layerFixed),
    score,
    pinned,
    status: it.status,
    text: String(it.text ?? "").trim(),
    tags: Array.isArray(it.tags) ? it.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 8) : [],
    day: it.day ? String(it.day) : "",
    source: String(it.source || "manual"),
    createdAt: Number(it.createdAt) || now,
    updatedAt: Number(it.updatedAt) || now,
    lastUsedAt: Number(it.lastUsedAt) || 0,
    hits: Number(it.hits) || 0,
  };
}

export function writeStore(store) {
  const p = storeFile();
  const now = Date.now();
  const out = { version: 1, updatedAt: now, items: store.items.map(normalize), meta: store.meta || {} };
  const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, JSON.stringify(out, null, 1), "utf8");
  // 换日留一份备份（一天只留一份）
  try {
    const day = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
    if (out.meta.backupDay !== day) {
      if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak-${day}`);
      out.meta.backupDay = day;
    }
  } catch {
    /* 备份失败不影响主库 */
  }
  fs.renameSync(tmp, p);
  return out;
}

export function listItems({ key, layer, status, q, limit = 500 } = {}) {
  const store = readStore();
  let items = store.items;
  if (key) items = items.filter((x) => x.key === key);
  if (layer === "working") return []; // 工作记忆不在库里，见 runtime\memory-last.json
  if (layer === "cold") items = items.filter((x) => x.status === "cold");
  else {
    items = items.filter((x) => x.status !== "cold");
    if (layer && LAYERS.includes(layer)) items = items.filter((x) => x.layer === layer);
  }
  if (status) items = items.filter((x) => x.status === status);
  if (q) {
    const s = String(q).toLowerCase();
    items = items.filter(
      (x) => x.text.toLowerCase().includes(s) || x.tags.some((t) => t.toLowerCase().includes(s)),
    );
  }
  items.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt);
  return items.slice(0, limit).map(normalize);
}

export function stats() {
  const store = readStore();
  const s = { core: 0, long: 0, mid: 0, short: 0, cold: 0, total: store.items.length, keys: {} };
  let scoreSum = 0;
  for (const raw of store.items) {
    const it = normalize(raw);
    s[it.status === "cold" ? "cold" : it.layer] += 1;
    scoreSum += it.score;
    s.keys[it.key] = (s.keys[it.key] || 0) + 1;
  }
  s.avgScore = store.items.length ? Math.round((scoreSum / store.items.length) * 10) / 10 : 0;
  s.updatedAt = store.updatedAt;
  return s;
}

// 新增/合并一条：同一 key 下文字相同（或一条包含另一条且都够长）就算同一条，取更高的分
export function upsert(item) {
  const store = readStore();
  const now = Date.now();
  const it = normalize({ ...item, createdAt: item.createdAt || now, updatedAt: now });
  const nt = normText(it.text);
  const idx = store.items.findIndex((x) => {
    if (String(x.key) !== it.key) return false;
    const other = normalize(x);
    if (other.status === "cold" && it.status === "active") return false;
    const n = normText(other.text);
    if (!n || !nt) return false;
    if (n === nt) return true;
    const long = Math.min(n.length, nt.length);
    return long >= 12 && (n.includes(nt) || nt.includes(n));
  });
  if (idx >= 0) {
    const old = normalize(store.items[idx]);
    store.items[idx] = normalize({
      ...old,
      text: nt.length > normText(old.text).length ? it.text : old.text,
      score: Math.max(old.score, it.score),
      tags: [...new Set([...old.tags, ...it.tags])].slice(0, 8),
      pinned: old.pinned || it.pinned,
      day: it.day || old.day,
      source: it.source || old.source,
      updatedAt: now,
    });
    writeStore(store);
    return store.items[idx];
  }
  store.items.push(it);
  writeStore(store);
  return it;
}

export function upsertMany(items) {
  const out = [];
  for (const it of items) {
    try {
      if (!it?.text) continue;
      out.push(upsert(it));
    } catch {
      /* 单条失败不影响其它 */
    }
  }
  return out;
}

export function updateItem(id, patch = {}) {
  const store = readStore();
  const idx = store.items.findIndex((x) => x.id === id);
  if (idx < 0) return null;
  const old = normalize(store.items[idx]);
  const merged = { ...old, ...patch, updatedAt: Date.now() };
  if (patch.text != null) merged.text = String(patch.text).trim();
  if (patch.score != null) merged.score = clampScore(patch.score);
  if (patch.layer != null && LAYERS.includes(patch.layer)) {
    merged.layer = patch.layer;
    merged.layerFixed = true; // 手动指定层就不再被分数自动改
    merged.pinned = patch.layer === "core" ? true : merged.pinned;
  }
  if (patch.pinned != null) {
    merged.pinned = Boolean(patch.pinned);
    merged.layerFixed = false;
  }
  if (patch.status === "active") {
    merged.status = "active";
    merged.score = Math.max(merged.score, 30);
    merged.layerFixed = false;
  }
  merged.layer = merged.pinned ? "core" : merged.layerFixed ? merged.layer : layerOf(merged.score, false);
  if (merged.status === "cold") merged.layer = "short";
  store.items[idx] = normalize(merged);
  writeStore(store);
  return store.items[idx];
}

export function removeItem(id) {
  const store = readStore();
  const before = store.items.length;
  store.items = store.items.filter((x) => x.id !== id);
  if (store.items.length === before) return false;
  writeStore(store);
  return true;
}

// 被检索到/被拼进提示词：加一点分，记一次用到（淡忘会慢下来）
export function touch(ids) {
  if (!ids?.length) return 0;
  const store = readStore();
  const set = new Set(ids);
  let n = 0;
  const now = Date.now();
  for (const raw of store.items) {
    const it = normalize(raw);
    if (!set.has(it.id)) continue;
    if (it.status === "cold") {
      it.status = "active";
    }
    // 20 小时内被用过就不再重复加分，免得天天开口就把分数顶满
    if (now - it.lastUsedAt > 20 * 3600e3) {
      it.score = clampScore(Math.min(96, it.score + 2));
    }
    it.lastUsedAt = now;
    it.hits += 1;
    it.layer = it.pinned || it.layerFixed ? it.layer : layerOf(it.score, false);
    it.updatedAt = now;
    Object.assign(raw, normalize(it));
    n++;
  }
  if (n) writeStore(store);
  return n;
}

// 淡忘：按"多久没碰过"降分；分数掉到层外就自动换层，跌破 12 冷藏（不再进提示词，面板里还在）
export function decayAll(now = Date.now()) {
  const store = readStore();
  let changed = 0;
  const cold = [];
  for (const raw of store.items) {
    const it = normalize(raw);
    if (it.status === "cold" || it.pinned) continue;
    const last = Math.max(it.updatedAt, it.lastUsedAt);
    const days = (now - last) / 86400000;
    if (days < 1) continue;
    const rate = RATE[it.layer] ?? 0;
    if (!rate) continue;
    const drop = Math.max(1, Math.round(rate * days));
    it.score = Math.max(FLOOR[it.layer] ?? 1, it.score - drop);
    const before = it.layer;
    it.layer = layerOf(it.score, false);
    if (it.score < COLD_BELOW) {
      it.status = "cold";
      it.layer = "short";
      cold.push(it.text.slice(0, 24));
    }
    it.updatedAt = now;
    Object.assign(raw, normalize(it));
    if (before !== it.layer || it.status === "cold") changed++;
  }
  if (changed) writeStore(store);
  return { changed, cold };
}

// 时间戳：让她看一条就知道「这事离现在多久了」。
// 格式【10-20·3天前】；不是今年的带上年份【·10个月前】。
// 每段前加时间戳，对时间有感知。
function cstNowParts() {
  const d = new Date(Date.now() + 8 * 3600e3);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

export function relDay(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return "";
  const now = cstNowParts();
  const today = Date.UTC(now.y, now.m - 1, now.d);
  const then = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const diff = Math.round((today - then) / 86400000);
  if (diff <= 0) return "今天";
  if (diff === 1) return "昨天";
  if (diff < 7) return `${diff}天前`;
  if (diff < 30) return `${Math.floor(diff / 7)}周前`;
  if (diff < 365) return `${Math.floor(diff / 30)}个月前`;
  return `${Math.floor(diff / 365)}年前`;
}

export function stampOf(day) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
  if (!m) return "";
  const rel = relDay(day);
  if (!rel) return "";
  const now = cstNowParts();
  const label = Number(m[1]) === now.y ? `${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}`;
  return `【${label}·${rel}】`;
}

// 同分时排谁：本会话最前，共用档案页其次，别的会话最后
function ownRank(itemKey, key) {
  if (itemKey === key) return 0;
  if (itemKey === "shared") return 1;
  return 2;
}

// 全解开时给别的会话的条目加个来处标签：私聊 / 群号。自己的和共用的不加。
function whereOf(itemKey, key) {
  if (!itemKey || itemKey === key || itemKey === "shared") return "";
  const m = /^(private|group):(.+)$/.exec(String(itemKey));
  if (!m) return "";
  return m[1] === "private" ? "【私聊】" : `【群${m[2]}】`;
}

// 拼提示词用的四块（永久/长期/中期/短期），按分数取，带字数上限
// opts.allKeys = true 时不再只看本会话 + 共用那几页，所有会话的记性都进候选（全解开）；
// 排序照样先按分数，所以本会话和共用块自然排在前面，别的群、私聊的排在后面。
export function buildBlocks(key, opts = {}) {
  // 每条前面多了个十来字的时间戳，上限相应放宽一点（不至于把内容挤掉）
  const caps = { core: 1200, long: 850, mid: 750, short: 500, ...(opts.caps || {}) };
  const store = readStore();
  const mine = store.items
    .map(normalize)
    .filter(
      (x) =>
        x.status !== "cold" &&
        (opts.allKeys ? true : x.key === key || x.key === "shared"),
    )
    // 分数一样的先排本会话的（共用的其次），别让别的群的旧事挤掉自己的
    .sort(
      (a, b) =>
        b.score - a.score ||
        ownRank(a.key, key) - ownRank(b.key, key) ||
        b.updatedAt - a.updatedAt,
    );
  const used = [];
  const take = (layer, cap) => {
    let out = "";
    for (const it of mine) {
      if (it.layer !== layer) continue;
      // 永久层不带时间戳——「不知道什么时候记的，但很重要」
      const stamp = layer === "core" ? "" : stampOf(it.day);
      // 全解开以后，别的群/私聊的事也进来了：标一下来处，免得把群 A 的事当成群 B 的
      const from = opts.allKeys ? whereOf(it.key, key) : "";
      // 一条太长就截断，别整条跳过（当天小结常常就很长）
      const room = cap - out.length - stamp.length - from.length - 4;
      if (room < 24) break;
      const body = it.text.length > room ? `${it.text.slice(0, room - 1)}…` : it.text;
      out += `- ${from}${stamp}${body}\n`;
      // 只有本会话和共用块算「被用到了」；别的群/私聊的条目被顺带翻出来不加分，
      // 免得群聊热闹几天就把私聊的旧事顶到永久层去
      if (it.key === key || it.key === "shared") used.push(it.id);
    }
    return out.trim();
  };
  return {
    core: take("core", caps.core),
    long: take("long", caps.long),
    mid: take("mid", caps.mid),
    short: take("short", caps.short),
    usedIds: used,
  };
}

// 一天结出来的要点进中期；同一天同一条不重复
export function addDayNotes(key, day, bullets, score = 62) {
  return upsertMany(
    (bullets || []).map((b) => ({
      key,
      layer: "mid",
      score,
      day,
      source: "ledger",
      text: String(b).replace(/^[-·•]\s*/, "").trim(),
      tags: [],
    })),
  );
}

// 当天小结：同一会话只留一条，随小结重写
export function setSessionShort(key, day, text) {
  const store = readStore();
  const id = `short:${key}:${day}`;
  // 小结文件是「- 」行格式；进库时去掉行首符号和空行，拼成一条
  const body = String(text || "")
    .split("\n")
    .map((l) => l.replace(/^[-*·•]\s*/, "").trim())
    .filter((l) => l && !/^[-–—]$/.test(l))
    .join("\n")
    .slice(0, 1200);
  const it = normalize({ id, key, layer: "short", score: 40, day, source: "short", text: body });
  const idx = store.items.findIndex((x) => x.id === id);
  if (idx >= 0)
    store.items[idx] = normalize({
      ...it,
      createdAt: store.items[idx].createdAt,
      score: Math.max(store.items[idx].score ?? 40, 40),
    });
  else store.items.push(it);
  // 只留最近 3 天的当天小结
  const shorts = store.items.filter((x) => x.id.startsWith(`short:${key}:`));
  const drop = new Set(shorts.slice(0, Math.max(0, shorts.length - 3)).map((x) => x.id));
  if (drop.size) store.items = store.items.filter((x) => !drop.has(x.id));
  writeStore(store);
  return it;
}
