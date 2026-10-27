// 观澜的记忆库（2026-10-21 主人定的五层 + 打分 + 淡忘）
//
// 五层：
//   永久 core   —— 人设、规矩、答应的事、定下来的偏好；分数 ≥88；不衰减
//   长期 long   —— 70–87 分；慢慢降温（-0.5/天，最低 55）
//   中期 mid    —— 45–69 分；日子账结出来的要点（-2/天）
//   短期 short  —— 12–44 分；当天小结、临时事（-5/天，跌破 12 就冷藏）
//   工作 working—— 不进库：当前这轮实际拼进提示词的那几块，由机器人落 runtime\memory-last.json 给面板看
//
// 分数是"以后还用不用得上"，不是"这件事当时重不重要"。她自己在夜里给新事实打分，
// 面板上也能手改。分数变了，层跟着变（layerOf）；分数被淡忘压下去，就自然沉到下一层。
// 2026-10-23 主人定的：进哪层只看分数，面板上手选层不再算数（layerFixed 那套已废）。
// 「钉住」只剩一个意思——不淡忘；它不再把条目硬塞进永久层。
//
// 存储：home\memory\store.json（面板和机器人共用，读改写 + rename，热更不用重启）。
//
// 2026-10-23 主人放话「有把握就全做」（写入合并 / 检索加权 / 每晚巩固 / 条目互联），
// 同一天又让把合并口径重划一遍：
//   写入：先过硬条件——数字对不上、名字对不上、否定对不上一律不并（怕把「余额 90.71」
//         并成「余额 95.23」、把「〔群友丙〕」和「林」并成一个人）；过了硬条件再去掉虚词比内容，
//         够像才并，半像的挂着进 pending.json，夜里让模型判。旧的留版本、标 superseded，不删。
//   互联：没并到一起的也互相挂 links，检索到一条能顺带想起另一条。
//         2026-10-23 修：原来只给「半像」的挂链，实测这套库里 78 条 active 记忆的
//         978 个同 key 两两组合，二字组重合 ≥0.4 的只有 1 对——同 key 下的条目本来就
//         在讲不同的事，靠相似度根本挂不出链。改成按「共享实体」挂：同一个 key 下
//         抽到的实体有一个重合就互相挂（实体表见 home\memory\entity-terms.mjs），
//         实测能挂上 69/78 条。两条新入口：写入时 linkByEntities()、启动时 relinkAll()。
import fs from "node:fs";
import path from "node:path";
import { entitiesIn, initEntityTerms, isRareEntity } from "../home/memory/entity-terms.mjs";
import * as cite from "./cite.mjs";

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

// 当天小结的分数上限（2026-10-27 修 D2）：mid 线是 45，卡在 44 就永远待在短期层。
// 它是「今天的事」，不该因为被想起几回就升格成长期结论。
const DAILY_SHORT_MAX = 44;

// 写入合并的门槛在「像不像」那一节里（2026-10-23 重划）：够像就并，半像挂着夜里判
const QUEUE_SIM = 0.4;
const MAX_LINKS = 6;
const MAX_PENDING = 120;

let storeDir = "";
let storePath = "";
let pendingPath = "";

// 会话键统一（2026-10-23 修）：库里一直有 group_1000000002 和 group:1000000002 两套写法，
// 16 条笔记落在错的那套下面，去重和「全解开」都翻不到它们。读的时候一律折成冒号那种。
export function canonKey(k) {
  const s = String(k ?? "").trim();
  const m = /^(private|group)[_:](\d{3,})$/.exec(s);
  return m ? `${m[1]}:${m[2]}` : s || "shared";
}

export function initMemoryStore(homeDir) {
  storeDir = path.join(homeDir, "memory");
  storePath = path.join(storeDir, "store.json");
  pendingPath = path.join(storeDir, "pending.json");
  fs.mkdirSync(storeDir, { recursive: true });
  loadNames();
  try {
    initEntityTerms(homeDir);
  } catch {
    /* 实体表装不上就只用相似度挂链，别拦启动 */
  }
  // 顺手把老的 group_xxx 键折成 group:xxx，并把折完撞在一起的老条目并掉（只动真有变化的）
  try {
    normalizeKeys();
  } catch {
    /* 折不动就算了，别拦着启动；主库坏了 readStore 自己会留备份 */
  }
  // 按共享实体把 links 补一遍（2026-10-23）：老条目一条链都没挂上过，
  // 这次补完以后写入时就顺手挂了；有变化才落盘。
  try {
    linkByEntities();
  } catch {
    /* 挂不上就算了，检索还能走向量+关键词 */
  }
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

// ---------- 像不像（2026-10-23 重做）----------
// 原来单看二字组重合率：该并的（换说法）落在 0.3–0.7，不该并的（换个数字、换个人）
// 也能爬到 0.5 左右，两堆叠在一起，调 0.75 这个数怎么调都切不开。现在分两层判：
//   一、硬条件：数字对不上、名字对不上、否定对不上，一律不并（只挂链、进待判队列）；
//   二、过了硬条件再比内容：先去掉「我/他/的/让/以后」这类虚词，剩下的才叫内容；
//       二字组重合 ≥0.75 算同一件事；换说法换得狠的（0.4 以上且逐字重合 ≥0.85）也算；
//       一条内容整体被另一条包住（≥4 字）算补充，不并也合。
const MERGE_SIM = 0.75;
const REPHRASE_SIM = 0.4;
const REPHRASE_DICE = 0.85;
const QUEUE_DICE = 0.5;

// 虚词：只影响"怎么说"，不影响"说的是谁、几号、什么数"，比之前先拿掉。
// 称呼（主人/爸爸/小宝/〔昵称甲〕）也算虚词：换称呼说的是同一件事，别因此判成两件（2026-10-23 补）。
// 长的写在前头，免得「我们」先被「我」拆了。
const FILLER =
  /(我们|你们|他们|她们|咱们|自己|主人|爸爸|小宝|〔昵称甲〕|要求|我|你|他|她|它|的|地|得|了|着|过|让|以后|之前|现在|当时|就是|还是|说|讲|也|都|就|还|又|是|在|有|会|要|把|被|给|跟|和|与|这|那|个|一下|已经|什么|怎么|时候|的话|其实|然后|而且|所以|但是|不过|比较|挺|很|太|真|一律|全|吗|呢|吧|啊|呀|哦|嗯)/g;

// 去掉虚词、空格、标点，中文数字换成阿拉伯数字（二十天 → 20天），剩下的就是内容
function contentText(t) {
  return normText(t)
    .replace(FILLER, "")
    .replace(CN_NUM_UNIT_RE, (m, cn, unit) => {
      const v = cnValue(cn);
      return v == null ? m : `${v}${unit}`;
    })
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function bigrams(t) {
  const s = contentText(t);
  const out = new Set();
  if (s.length < 2) {
    if (s) out.add(s);
    return out;
  }
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

// 逐字重合（只看有哪些字，不看顺序）：换说法时最稳的那根线
export function charSimilarity(a, b) {
  const A = [...new Set(contentText(a))];
  const B = new Set(contentText(b));
  if (!A.length || !B.size) return 0;
  let inter = 0;
  for (const c of A) if (B.has(c)) inter++;
  return (2 * inter) / (A.length + B.size);
}

export function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  const jacc = inter / (A.size + B.size - inter);
  const min = Math.min(A.size, B.size);
  // 太短的一句会被长句「整个包住」，重合率虚高：短句只认杰卡德
  if (min < 6) return jacc;
  return (jacc + inter / min) / 2;
}

// ---------- 硬条件（2026-10-23 主人定的）----------
const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_MUL = { 十: 10, 百: 100, 千: 1000 };

// 「九十」→90、「两千」→2000；认不出就原样返回
function cnValue(s) {
  let total = 0;
  let section = 0;
  let digit = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in CN_DIGIT) {
      digit = CN_DIGIT[ch];
      seen = true;
    } else if (ch in CN_MUL) {
      section += (digit || 1) * CN_MUL[ch];
      digit = 0;
      seen = true;
    } else if (ch === "万") {
      total += (section + digit) * 10000;
      section = 0;
      digit = 0;
      seen = true;
    }
  }
  return seen ? total + section + digit : null;
}

// 句子里出现的数（阿拉伯数字 + 后面跟着单位的中文数字）。
// 中文数字必须带单位才算，不然「一直」「十分」「一起」全成了数字。
const NUM_UNIT = "点|号|月|日|天|周|年|次|个|小时|分钟|分|秒|元|块|岁|人|倍|成|层|页|条|句|张|件|位|名|楼|斤|公里|米|度";
const CN_NUM_RE = new RegExp(`([零〇一二三四五六七八九十百千万两]+)(?:${NUM_UNIT})`, "g");
// 比内容时也用它把「二十天」折成「20天」，跟「20天」对上
const CN_NUM_UNIT_RE = new RegExp(`([零〇一二三四五六七八九十百千万两]+)(${NUM_UNIT})`, "g");
function numbersIn(t) {
  const s = normText(t);
  const out = new Set();
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) out.add(String(Number(m[0])));
  for (const m of s.matchAll(CN_NUM_RE)) {
    const v = cnValue(m[1]);
    if (v != null) out.add(String(v));
  }
  return out;
}

// 认得的人名：这里加名字就行；称呼（爸爸、小宝、〔昵称甲〕）不算人名，别加——
// 那是同一个人，加进来反而会把该并的挡住。
// 懒办法：home\memory\names.json 写成 ["新名字"]，启动时并进来，不用改代码。
let NAMES = ["萤", "〔群友乙〕", "〔群友甲〕", "〔群友丙〕", "〔群友己〕", "林", "〔群友戊〕", "月", "〔群友丁〕"];

function loadNames() {
  try {
    const arr = JSON.parse(fs.readFileSync(path.join(storeDir, "names.json"), "utf8").replace(/^\uFEFF/, ""));
    if (Array.isArray(arr)) {
      const add = arr.map((x) => String(x).trim()).filter((x) => x.length >= 1);
      if (add.length) NAMES = [...new Set([...NAMES, ...add])];
    }
  } catch {
    /* 没有名字表就用默认的 */
  }
}

function namesIn(t) {
  const s = normText(t);
  const out = new Set();
  for (const n of NAMES) if (s.includes(n)) out.add(n);
  return out;
}

// 否定词：只在它真的否定一句话时才算（「别人」「别的」不算）
const NEG_RE = /不|没(?:有|收|法)?|未|取消|删|停|免|禁|别(?!人|的|处|家|个|事|样|管)/g;
function negationIn(t) {
  const s = normText(t);
  const out = new Set();
  for (const m of s.matchAll(NEG_RE)) out.add(m[0]);
  return out;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// 硬条件一个个过，谁对不上就返回谁的名字；全过返回空串
function conflictOf(na, nb) {
  if (!sameSet(numbersIn(na), numbersIn(nb))) return "数字";
  const nameA = namesIn(na);
  const nameB = namesIn(nb);
  if (nameA.size && nameB.size && ![...nameA].some((x) => nameB.has(x))) return "名字";
  if (!sameSet(negationIn(na), negationIn(nb))) return "否定";
  return "";
}

// 一条总判定：并 / 不并，以及为什么。写入和启动去重都走这一个口子。
export function sameness(a, b) {
  const na = normText(a);
  const nb = normText(b);
  const sim = similarity(na, nb);
  const dice = charSimilarity(na, nb);
  if (!na || !nb) return { same: false, sim: 0, dice: 0, conflict: "" };
  if (na === nb) return { same: true, sim: 1, dice: 1, conflict: "" };
  const conflict = conflictOf(na, nb);
  if (conflict) return { same: false, sim, dice, conflict };
  const ca = contentText(na);
  const cb = contentText(nb);
  const short = ca.length <= cb.length ? ca : cb;
  const long = ca.length <= cb.length ? cb : ca;
  if (short.length >= 4 && long.includes(short)) return { same: true, sim, dice, conflict: "" };
  if (sim >= MERGE_SIM) return { same: true, sim, dice, conflict: "" };
  if (sim >= REPHRASE_SIM && dice >= REPHRASE_DICE) return { same: true, sim, dice, conflict: "" };
  return { same: false, sim, dice, conflict: "" };
}

// ---------- 待判队列（写入时半像的两条，等夜里模型判）----------
function readPending() {
  if (!pendingPath) return [];
  try {
    const arr = JSON.parse(fs.readFileSync(pendingPath, "utf8").replace(/^\uFEFF/, ""));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePending(list) {
  if (!pendingPath) return;
  const tmp = `${pendingPath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1), "utf8");
    fs.renameSync(tmp, pendingPath);
  } catch {
    /* 队列写不进去不影响入库 */
  }
}

export function pendingList() {
  return readPending();
}

function queuePending(a, b, sim, why) {
  if (!pendingPath || !a?.id || !b?.id) return;
  // 群的对子不进队（2026-10-24 体检修）：唯一会判它的 consolidateDay 开头就把 group 挡了
  // （「群的记性留群里」），排进去等于只进不出。链接在 linkInStore 里已经挂好，这里不入队不丢信息。
  if (String(a.key || "").startsWith("group:")) return;
  const list = readPending();
  if (list.some((p) => (p.a === a.id && p.b === b.id) || (p.a === b.id && p.b === a.id))) return;
  list.push({
    at: Date.now(),
    key: a.key,
    a: a.id,
    b: b.id,
    sim: Math.round(sim * 100) / 100,
    why,
    aText: String(a.text || "").slice(0, 180),
    bText: String(b.text || "").slice(0, 180),
  });
  // 30 天前的老账判了也没用；只留最近的一批，别滚成雪球
  const cut = Date.now() - 30 * 86400000;
  writePending(list.filter((p) => p.at > cut).slice(-MAX_PENDING));
}

// 判完了把这一对从队列里摘掉（带错 id 也不会崩）
export function clearPending(aId, bId) {
  const list = readPending();
  const rest = list.filter(
    (p) => !((p.a === aId && p.b === bId) || (p.a === bId && p.b === aId)),
  );
  if (rest.length !== list.length) writePending(rest);
  return list.length - rest.length;
}

// 清掉「注定没人判」的待判对（2026-10-24 体检修）。
// 起因：consolidateDay 开头 `if (key.startsWith("group:")) return`，群的记性留群里，
// 所以群的对子从来不会有人判；而 queuePending 照写不误 → 只进不出。
// 实测 10-23 还是 0 条，一天涨到 18 条（group 13 / private 5），文件还会跟着进 git。
// 这里按四条规则过期：
//  1) 群的对子直接清：判它的路已经封了（queuePending 那边也不再写进来），留着纯占位；
//  2) 有一头的条目已经不在库里了 → 判了也没对象；
//  3) 有一头已经不是 active（被顶掉 / 冷藏）→ 巩固逻辑本来也会跳过，留着没意义；
//  4) 超过 keepDays（30 天，与 queuePending 写入时的口径一致）的私聊对子。
export function prunePending({ keepDays = 30 } = {}) {
  const list = readPending();
  if (!list.length) return 0;
  const now = Date.now();
  const alive = new Map(readStore().items.map((x) => [x.id, x]));
  let groups = 0;
  const rest = list.filter((p) => {
    if (String(p.key || "").startsWith("group:")) {
      groups++;
      return false;
    }
    const a = alive.get(p.a);
    const b = alive.get(p.b);
    if (!a || !b) return false;
    if (a.status !== "active" || b.status !== "active") return false;
    return now - Number(p.at || 0) < keepDays * 86400000;
  });
  const dropped = list.length - rest.length;
  if (dropped) writePending(rest);
  if (groups) return { dropped, groups };
  return dropped;
}

// ---------- 互联与顶替 ----------
function linkInStore(store, aId, bId) {
  if (!aId || !bId || aId === bId) return;
  for (const [x, y] of [
    [aId, bId],
    [bId, aId],
  ]) {
    const it = store.items.find((r) => r.id === x);
    if (!it) continue;
    it.links = [...new Set([...(it.links || []), y])].slice(0, MAX_LINKS);
  }
}

// 否定极性的正确判法（2026-10-23 晚，为挂链加的）。
// 中文的否定是贴着被否定的那个词起作用的：「没答应过什么」否定的是「答应」，
// 而「别又摸手机，还欠着周五要画的图」里的「别」否定的是「摸手机」，跟「欠着」半点关系没有。
// 所以不能像 conflictOf 那样比整句的否定词集合——实测那么比，现有 40 条链里 33 条会被误判。
// 只能对「共享的那个实体」单独看：它所在的那一个分句里、在它之前的那一段，有没有否定词。
const SEG_SEP = /[，。！？；：、,.!?;:（）()「」【】“”"']/;
const PRE_NEG = /[不没未禁免消删停]|别(?!人|的|处|家|个|事|样|管)/;
const SEG_FILLER = /[都已还也又再就才曾的着]/g;

function segOf(text) {
  // 换行先变成句号再删空白：不然跨行会粘成「别又摸手机还欠着」，把「别」算到「欠着」头上
  return String(text ?? "").replace(/[\r\n]+/g, "。").replace(/\s+/g, "");
}

// 这个实体在这条文本里被否定了吗？true=否定 / false=肯定 / undefined=判不了
function entityPolarity(text, ent) {
  const s = segOf(text);
  const out = [];
  for (let i = s.indexOf(ent); i >= 0; i = s.indexOf(ent, i + 1)) {
    let start = i;
    while (start > 0 && !SEG_SEP.test(s[start - 1])) start--;
    out.push(PRE_NEG.test(s.slice(start, i).replace(SEG_FILLER, "")));
  }
  if (!out.length) return undefined;
  if (out.every(Boolean)) return true;
  if (out.every((x) => !x)) return false;
  // 同一实体在这条里一处肯定一处否定：它自己都说不清，别拿它当判据
  return undefined;
}

// 共享词里只要有一个「一边肯定一边否定」，就认为这对说的不是一回事。返回那个词，没冲突返回空串。
function polarityConflict(aText, bText, shared) {
  for (const e of shared) {
    const pa = entityPolarity(aText, e);
    const pb = entityPolarity(bText, e);
    if (pa === undefined || pb === undefined) continue;
    if (pa !== pb) return e;
  }
  return "";
}

// 按共享实体挂链（2026-10-23 加）：同 key、都在 active、且抽出的实体有重合，
// 按「共享实体多」优先、每条只留前 MAX_LINKS 个，重新算一遍。
// 为什么不能先到先得：links 有 6 个上限，而「主人」这种词横跨十几条，
// 先到先得会把同 key 里共享实体更多的链挤掉。
// 只连同一个 key 的——跨会话的实体重合太泛（「主人」到处都有），会连成一锅粥。
//
// 2026-10-23 收口（主人点头「就按你说的调吧」）：只有「稀罕词」才算数。
// 原来沾一个词就挂，实测问「大白饭」会捎来「命令行修好」「KFC.txt」这种半点不沾的，
// 13 条里 11 条跑题；因为「主人/爸爸/答应/私聊」这种词横跨十几条，一沾就挂上了。
// 现在共享实体里至少得有一个 df ≤ ENT_DF_MAX（显卡 9、白色风车 10、补丁 4 算；
// 主人 534、余额 438、答应、〔主人名〕 800+ 不算），配对才成立。
// 代价：能挂上链的条目从 60/70 降到 30/70 左右——宁可少挂，不要挂错。
export function linkByEntities({ save = true } = {}) {
  if (!storePath) return 0;
  const store = readStore();
  const byKey = new Map();
  for (const it of store.items) {
    const x = normalize(it);
    if (x.status !== "active" || x.layer === "short") continue;
    const ents = entitiesIn(x.text);
    if (!ents.length) continue;
    if (!byKey.has(x.key)) byKey.set(x.key, []);
    byKey.get(x.key).push({ id: x.id, text: x.text, ents: new Set(ents) });
  }
  // 先算出每个条目应挂的候选及共享的稀罕词数
  const want = new Map(); // id -> Map(其他id, 共享稀罕词数)
  const touch = (a, b, n) => {
    if (!want.has(a)) want.set(a, new Map());
    want.get(a).set(b, n);
  };
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        let n = 0;
        const shared = [];
        for (const e of list[i].ents)
          if (list[j].ents.has(e) && isRareEntity(e)) {
            n++;
            shared.push(e);
          }
        if (!n) continue;
        // 2026-10-23 晚：共享词里有一个两边极性相反（一条说「答应了」、另一条说「没答应过」），
        // 说的不是一回事，不挂。只看共享词本身，不看整句的否定词。
        if (polarityConflict(list[i].text, list[j].text, shared)) continue;
        touch(list[i].id, list[j].id, n);
        touch(list[j].id, list[i].id, n);
      }
  }
  const byId = new Map();
  for (const it of store.items) byId.set(it.id, it);
  // 待判队列里那几对是「半像但没并」的，夜里模型还要拿它们判，链不能丢
  const pend = new Set();
  for (const p of readPending()) {
    if (p?.a && p?.b) {
      pend.add(`${p.a}|${p.b}`);
      pend.add(`${p.b}|${p.a}`);
    }
  }
  let added = 0;
  let changed = 0;
  // 遍历「所有该重算的条目」，不只 want 里有候选的那些——
  // 以前只走 want，一个条目这次算不出候选时就被跳过，旧链原样留着，
  // 等于「只认稀罕词」对这批条目完全没生效（2026-10-23 实测发现的）。
  const targets = new Set();
  for (const it of store.items) {
    const x = normalize(it);
    if (x.status !== "active" || x.layer === "short") continue;
    targets.add(x.id);
  }
  for (const id of want.keys()) targets.add(id);
  for (const id of targets) {
    const it = byId.get(id);
    if (!it) continue;
    const x = normalize(it);
    if (x.status !== "active" || x.layer === "short") continue;
    const old = new Set(it.links || []);
    const cands = want.get(id) || new Map();
    // 共享稀罕词多的优先；一样多时按 id 排，保证每次跑结果一致
    const top = [...cands.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .slice(0, MAX_LINKS)
      .map(([k]) => k);
    // 老的那条如果是待判队列里的，就算实体不重合也留着（不然夜里判的时候链没了）
    for (const k of old)
      if (!top.includes(k) && pend.has(`${id}|${k}`) && top.length < MAX_LINKS) top.push(k);
    for (const k of top) if (!old.has(k)) added++;
    // 断开也是改动：收了线要落盘，不然库里还留着旧链
    if (top.length !== old.size || top.some((k) => !old.has(k))) changed++;
    it.links = top;
  }
  if (changed && save) writeStore(store);
  return added;
}

export function link(aId, bId) {
  const store = readStore();
  linkInStore(store, aId, bId);
  writeStore(store);
  return true;
}

// 旧的被新的顶掉：不删，标 superseded 留着版本，出事能翻回去
export function supersede(oldId, byId) {
  const store = readStore();
  const old = store.items.find((x) => x.id === oldId);
  if (!old) return false;
  old.status = "superseded";
  old.supersededBy = String(byId || "");
  old.supersededAt = Date.now();
  if (byId) {
    const neu = store.items.find((x) => x.id === byId);
    if (neu) neu.supersedes = [...new Set([...(neu.supersedes || []), oldId])].slice(0, MAX_LINKS);
  }
  writeStore(store);
  return true;
}

// 键统一 + 折完撞在一起的并掉（启动时跑一次，没变化就不落盘）
export function normalizeKeys({ mergeDup = true } = {}) {
  if (!storePath) return { moved: 0, merged: 0 };
  const store = readStore();
  let moved = 0;
  for (const it of store.items) {
    const k = canonKey(it.key);
    if (k !== it.key) {
      it.key = k;
      moved++;
    }
  }
  let merged = 0;
  if (mergeDup) {
    const items = store.items.map(normalize);
    const dead = new Set();
    for (let i = 0; i < items.length; i++) {
      const a = items[i];
      if (dead.has(a.id) || a.status !== "active") continue;
      for (let j = i + 1; j < items.length; j++) {
        const b = items[j];
        if (dead.has(b.id) || b.status !== "active" || a.key !== b.key) continue;
        // 短期不并（2026-10-23 主人定的）：短期留着自己第二天压小结
        if (a.layer === "short" || b.layer === "short") continue;
        // 硬条件（数字/名字/否定）先过，再比内容；全交给 sameness 一个口子判
        const v = sameness(a.text, b.text);
        if (!v.same) continue;
        const keep = a.createdAt <= b.createdAt ? a : b;
        const drop = keep === a ? b : a;
        const keepOwnText = normText(keep.text).length >= normText(drop.text).length;
        keep.text = keepOwnText ? keep.text : drop.text;
        keep.score = Math.max(keep.score, drop.score);
        keep.tags = [...new Set([...keep.tags, ...drop.tags])].slice(0, 8);
        keep.links = [...new Set([...keep.links, ...drop.links])]
          .filter((x) => x !== keep.id && x !== drop.id)
          .slice(0, MAX_LINKS);
        keep.source = keep.source || drop.source;
        // 出处跟正文走（2026-10-23 修）：原来是「keep 没写就继承 drop」，可正文取的是
        // 较长那条——正文要是留了 drop 的，出处却可能挂着 keep 的，等于指回错地方。
        keep.cite = keepOwnText ? keep.cite : drop.cite;
        keep.day = keep.day || drop.day;
        keep.updatedAt = Math.max(keep.updatedAt, drop.updatedAt);
        keep.layer = layerOf(keep.score);
        store.items = store.items.filter((x) => x.id !== drop.id);
        const kIdx = store.items.findIndex((x) => x.id === keep.id);
        if (kIdx >= 0) store.items[kIdx] = normalize(keep);
        dead.add(drop.id);
        merged++;
        if (keep === a) break; // a 变了，这轮里别再拿它去比
      }
    }
  }
  if (moved || merged) writeStore(store);
  return { moved, merged };
}

// 层只看分数（2026-10-23 主人定的）：分数线是唯一出口，没有例外通道。
export function layerOf(score) {
  const s = clampScore(score);
  if (s >= 88) return "core";
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
  const score = clampScore(it.score);
  // 层只由分数算，旧库里存的 layer / layerFixed 一律不认，跟着分数重算
  let layer = layerOf(score);
  // 状态也跟着分数走（2026-10-23 修）：跌破 COLD_BELOW 自然冷藏；分数回到线上，
  // 冷藏自动解冻。原来只要 status 是 cold 就硬压回来，面板把分数调到 90 也解不了冻，
  // 层还一直显示短期。
  if (layer === "cold") it.status = "cold";
  else if (it.status === "cold") it.status = "active";
  if (layer === "cold") layer = "short";
  // 三种状态（2026-10-23）：active 在用 / cold 冷藏 / superseded 被新说法顶掉的旧版（留着不删）
  if (it.status !== "cold" && it.status !== "superseded") it.status = "active";
  const now = Date.now();
  return {
    id: String(it.id || newId()),
    key: canonKey(it.key),
    layer,
    score,
    pinned,
    status: it.status,
    text: String(it.text ?? "").trim(),
    tags: Array.isArray(it.tags) ? it.tags.map((x) => String(x).trim()).filter(Boolean).slice(0, 8) : [],
    day: it.day ? String(it.day) : "",
    source: String(it.source || "manual"),
    // 出处（2026-10-23 主人定的「每条结论都要能指回原话或新闻文件」）：
    // 卡:日期#时-分 / 原话:日期 时:分 / news:文件名；核不上的写「未核实」。
    cite: String(it.cite ?? "").trim().slice(0, 120),
    citeKind: String(it.citeKind ?? "").trim().slice(0, 12),
    createdAt: Number(it.createdAt) || now,
    updatedAt: Number(it.updatedAt) || now,
    lastUsedAt: Number(it.lastUsedAt) || 0,
    hits: Number(it.hits) || 0,
    // 【2026-10-27 修 hits 失真（A 档）】原来只有一个 hits，面板写「用过 N 次」，
    // 但它实际数的是「这条被拼进提示词的次数」（buildBlocks 的 usedIds），
    // 不是「真正用上了几次」。而且 touch() 里 hits += 1 没有跟那一句 +2 的 20 小时节流，
    // 于是每轮只要被选中就 +1 —— 实测 199 条里 hits 中位 0、p90 471、最高 1003，
    // 60% 是 0。这个数既不代表「用过」，也不代表「重要」，纯粹是注入次数。
    // 现在拆成两个字段：injected = 拼进过提示词几次（= 旧 hits 的真实语义）；
    // used = 真正被引用/用上几次（目前没有可靠信号，先留 0，不给假数据）。
    injected: Number(it.injected ?? it.hits) || 0,
    used: Number(it.used) || 0,
    // 【2026-10-27 修淡忘从未真正生效】decayAll 原来用 Math.max(updatedAt, lastUsedAt)
    // 算「多久没碰过」，可这两个字段都会被 touch() 每轮无条件刷新（:918/:925），
    // 连 decayAll 自己结算完也写 it.updatedAt = now —— 等于每次结算都把计时器清零，
    // 所以 days 永远 < 1、`if (days < 1) continue` 永远跳过。
    // 实测：177 条 active 里 99.4% 的 days < 1，24 小时只降过 3 条各 1 分。
    // 修法：给结算单独开一个只由 decayAll 写的锚点 lastDecayAt，谁都不许碰。
    lastDecayAt: Number(it.lastDecayAt) || 0,
    // 攒零头用的：long 每天只该掉 0.5 分，可分数是整数，原来 Math.round(0.5) = 1
    // 变成每天实扣 1 分（是应扣的 2 倍）。这里把不足 1 分的零头攒着，够了再扣。
    decayDebt: Number(it.decayDebt) || 0,
    // 条目互联（2026-10-23）：像但没并到一起的互相挂着，检索到一条能顺带想起另一条
    links: Array.isArray(it.links) ? [...new Set(it.links.map(String))].filter(Boolean).slice(0, MAX_LINKS) : [],
    // 新旧撞车：新的这条顶掉了哪些旧说法；旧那条留 version，标 superseded + 被谁顶的
    supersedes: Array.isArray(it.supersedes) ? [...new Set(it.supersedes.map(String))].filter(Boolean).slice(0, MAX_LINKS) : [],
    supersededBy: String(it.supersededBy || ""),
    supersededAt: Number(it.supersededAt) || 0,
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
  // 先按分数归一化再筛：库里可能留着旧版手选层的 layer，直接拿原字段筛会筛错人
  let items = store.items.map(normalize);
  if (key) items = items.filter((x) => x.key === key);
  if (layer === "working") return []; // 工作记忆不在库里，见 runtime\memory-last.json
  if (layer === "cold") items = items.filter((x) => x.status === "cold");
  else {
    // 被新说法顶掉的旧版（superseded）默认不露面；面板显式要 status=superseded 时才给
    items = items.filter(
      (x) => x.status !== "cold" && (status ? true : x.status !== "superseded"),
    );
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
  const s = { core: 0, long: 0, mid: 0, short: 0, cold: 0, superseded: 0, total: 0, keys: {} };
  let scoreSum = 0;
  for (const raw of store.items) {
    const it = normalize(raw);
    // 被并掉的旧版（superseded）只是留着能翻回去：不算进「共几条」、不拉低均分、也不占 key 计数
    if (it.status === "superseded") {
      s.superseded += 1;
      continue;
    }
    s[it.status === "cold" ? "cold" : it.layer] += 1;
    s.total += 1;
    scoreSum += it.score;
    s.keys[it.key] = (s.keys[it.key] || 0) + 1;
  }
  s.avgScore = s.total ? Math.round((scoreSum / s.total) * 10) / 10 : 0;
  s.updatedAt = store.updatedAt;
  return s;
}

// 新增/合并一条（2026-10-23 重划）：
//   硬条件不过（数字/名字/否定对不上）→ 绝不自动并：两条都留着、互相挂 links、
//   进 pending.json，夜里让模型判是同一件事（旧的标 superseded）还是撞车说法。
//   硬条件过了 → 内容够像就并（见 sameness），半像挂链等夜里判。
export function upsert(item) {
  const store = readStore();
  const now = Date.now();
  const it = normalize({ ...item, createdAt: item.createdAt || now, updatedAt: now });
  const nt = normText(it.text);
  if (!nt) return it;
  // 短期记忆不参与合并（2026-10-23 05:5x 主人定的）：短期是第二天要压小结的料，
  // 并进别的条目就再也压不出小结了。落进去的短期条目只当新条目，不并、不挂夜里判。
  const mergeable = it.layer !== "short";
  const pool = store.items
    .map(normalize)
    .filter((x) => x.key === it.key && x.status === "active" && x.layer !== "short");
  let best = null;
  let hit = null;
  for (const x of pool) {
    const v = sameness(x.text, it.text);
    if (mergeable && v.same) {
      hit = x;
      break;
    }
    if (!best || v.sim > best.sim || (v.sim === best.sim && v.dice > best.dice)) {
      best = { x, ...v };
    }
  }
  if (hit) return mergeInto(store, hit, it, now);
  store.items.push(it);
  const near = mergeable && best && (best.sim >= QUEUE_SIM || best.dice >= QUEUE_DICE);
  const op = near ? "queued" : "new";
  // 半像的那条先挂上（一次写盘就把这条链存进去）
  if (op === "queued") linkInStore(store, it.id, best.x.id);
  writeStore(store);
  // 再按共享实体把同 key 的链补全（2026-10-23 改）：不再只给「半像」的挂——
  // 实测 78 条 active 的 978 个同 key 组合，二字组重合 ≥0.4 的只有 1 对，
  // 靠相似度挂链等于没挂；实体有重合就挂，实测能盖住 69/78 条。
  let linked = 0;
  if (mergeable) {
    try {
      linked = linkByEntities();
    } catch {
      /* 挂不上不拦写入，检索照样能走向量 */
    }
  }
  if (op === "queued") {
    const why = best.conflict
      ? `硬条件没过（${best.conflict}对不上），不自动并，等夜里判`
      : "说法像但没到并的门槛，等夜里判";
    queuePending(it, best.x, best.sim, why);
  }
  it._op = op;
  if (linked) it._linked = linked;
  return it;
}

// 并进老那条：正文取长的、分数取高、标签并起来，出处只在新带的时候换
function mergeInto(store, old, it, now) {
  const idx = store.items.findIndex((x) => x.id === old.id);
  // 出处跟正文走（2026-10-23 修）：原来是「新的没写就继承老的」，可正文取的是
  // 较长那条——正文一旦留给老的，出处却可能挂着新的，指回去就是错的地方。
  const takeNew = normText(it.text).length > normText(old.text).length;
  const merged = normalize({
    ...old,
    text: takeNew ? it.text : old.text,
    score: Math.max(old.score, it.score),
    tags: [...new Set([...old.tags, ...it.tags])].slice(0, 8),
    pinned: old.pinned || it.pinned,
    // 日期跟正文走（2026-10-23 修）：原来固定取新条目的日期，可正文常常留的是
    // 较长的那条老文本——正文是旧的、日期是新的，时间就对不上了。
    day: takeNew ? it.day || old.day : old.day || it.day,
    source: it.source || old.source,
    cite: takeNew ? it.cite : old.cite,
    citeKind: takeNew ? it.citeKind : old.citeKind,
    updatedAt: now,
  });
  if (idx >= 0) store.items[idx] = merged;
  writeStore(store);
  merged._op = "merged";
  return merged;
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
  // 面板手选层从 2026-10-23 起不再生效：层只由分数算，传进来的 layer 直接丢掉。
  if (patch.pinned != null) merged.pinned = Boolean(patch.pinned);
  if (patch.status === "active") {
    merged.status = "active";
    merged.score = Math.max(merged.score, 30);
  }
  merged.layer = layerOf(merged.score);
  if (merged.status === "cold") merged.layer = "short";
  store.items[idx] = normalize(merged);
  writeStore(store);
  return store.items[idx];
}

// 按 id 取一条（判撞车、面板点开某条时用）
export function getItem(id) {
  const raw = readStore().items.find((x) => x.id === id);
  return raw ? normalize(raw) : null;
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
//
// 【2026-10-27 重写，B 档 + A 档】
// 旧行为：20 小时外 +2 定值；hits += 1（没节流）；每次无条件写 lastUsedAt / updatedAt。
// 三个问题：
//   ① 一次想起和十次想起一个待遇（节流把频率信息全吞了），不是 Hebb 强化；
//   ② hits 数的是「被拼进提示词几次」，面板却写「用过 N 次」——语义是错的；
//   ③ 无条件刷 updatedAt，把 decayAll 的计时器清零了（衰减从来不生效的根因）。
// 现在：
//   · injected 只记「拼进提示词几次」，used 留给真正的「引用」（现在没有可靠信号，不编）；
//   · 不再碰 lastDecayAt —— 那是 decayAll 独占的结算锚点，碰了衰减就又停了；
//   · 「想起来就不容易忘」改成让 decayAll 读 lastUsedAt 判断这段时间有没有被想起，
//     而不是靠刷新时间戳骗过衰减。这样信号是真的，语义也是对的。
export function touch(ids) {
  if (!ids?.length) return 0;
  const store = readStore();
  const set = new Set(ids);
  let n = 0;
  const now = Date.now();
  for (const raw of store.items) {
    const it = normalize(raw);
    if (!set.has(it.id)) continue;
    if (it.status === "superseded") continue; // 被顶掉的旧说法不因为被翻出来又活过来
    if (it.status === "cold") {
      // ⚠️ 2026-10-24 修（B6）：原来只把 status 改成 active、分数 +2 就算复活了。
      // 但分数在冷藏区（<12）的条目 +2 后还是 <12，`layerOf()` 仍返回 cold，
      // 结尾 `normalize()` 又把它压回 cold —— **复活等于没发生**。
      // 修法：复活要把它抬过冷藏线，最低给到 COLD_BELOW + 8，才真的回到短期层。
      it.status = "active";
      if (it.score < COLD_BELOW) it.score = clampScore(COLD_BELOW + 8);
    }
    // 20 小时内被用过就不再重复加分，免得天天开口就把分数顶满。
    // 20 小时这个门限保留（它挡的是「一天最多加一次」），频率信息由 decayAll 那边用。
    // 【2026-10-27 修 D2：当天小结不许加分】
    // 「当天小结」的 id 是 `short:<会话>:<日期>`，它的分数本来就该钉在短期层
    // （45 是 mid 线）。可 touch() 的 +2 会让它 40 → 42 → 44 → 46，
    // 一次跨过 mid 线就再也不是「短期记忆」了——实测 10-25、10-26 那三条当天小结
    // 分别停在 46 分、层是 mid，短期层因此只剩 9 条、其中 3 条还是 10-23/24 的老账。
    // 小结是「当天的事」，它不该因为被想起几回就升格成长期结论，所以下面单列一条：
    // 这类条目不参与加分，只在冷藏时被救回来（救回来那步在上面，不冲突）。
    const isDailyShort = it.id.startsWith("short:");
    if (!isDailyShort && now - it.lastUsedAt > 20 * 3600e3) {
      // 加分也不再是死板的 +2：隔得越久再被想起，说明这条越经得住忘，给得多一点。
      // 实测过的上限——原来按「+6 每天」算，core 会从 23 条涨到 143 条（core 只进不出），
      // 所以这里封在 +2~+4，且到 core 线（88）就停，不让它自己把永久层撑爆。
      const gapDays = (now - (it.lastUsedAt || it.createdAt)) / 86400000;
      const gain = Math.min(4, 2 + Math.floor(gapDays / 7));
      if (it.score < 88) it.score = clampScore(Math.min(96, it.score + gain));
    }
    it.lastUsedAt = now;
    it.injected += 1;
    it.layer = layerOf(it.score);
    it.updatedAt = now;
    Object.assign(raw, normalize(it));
    n++;
  }
  if (n) writeStore(store);
  return n;
}

// 淡忘：按"多久没碰过"降分；分数掉到层外就自动换层，跌破 12 冷藏（不再进提示词，面板里还在）
//
// 【2026-10-27 重写：这条从上线起就没真正跑过，这是本轮最深的发现】
// 原来算 idle 用 Math.max(updatedAt, lastUsedAt)，可这两个字段：
//   · touch() 每轮无条件刷（:948/:951）——只要这一轮她被问到、这条被拼进提示词就刷新；
//   · decayAll() 自己结算完也写 it.updatedAt = now（:987）——**每次结算都把计时器清零**。
// 结果 days 永远 < 1，`if (days < 1) continue` 把所有人跳过。
// 证据不是推断：
//   · logs 里「记忆淡忘」确实出现过 23 次（10-25T16:02 ~ 10-26T17:15），但每次只降 1~38 条；
//   · 24 小时内分数真降过的只有 3 条、各降 1 分；
//   · 159 条可衰减条目里 idle ≥ 1 天的数量 = **0**，而按 createdAt 算是有 135 条 ≥ 1 天的。
// 所以 RATE / FLOOR / COLD_BELOW 那套参数一直贴着「从没生效」，真正起作用的只有 cap 截断。
//
// 修法四条：
//   ① 结算锚点换成 **lastDecayAt**（只由本函数写，谁都不许碰）——第一次跑时回落到 createdAt，
//      这样「入库多久没被结算过」是真实的时间，不会被任何一次读写抹掉；
//   ② 结算后写 lastDecayAt = now，而不是写 updatedAt —— updatedAt 保留「内容最后被动过」的原义；
//   ③ 首轮不追溯全额积压：老库按 createdAt 算有的已经 6 天没结算，按 RATE=5 一天就是 -30，
//      会把一批还好好的短期记忆直接拍进冷藏。实测回放：不封顶首轮换层 15 条、冷藏 1 条；
//      封顶 1 天则换层 5 条、冷藏 0 条 —— 所以首轮（lastDecayAt = 0 的）按 1 天结算一次就停；
//   ④ long 的 0.5/天 用 decayDebt 攒零头：原来 Math.round(0.5)=1，实际每天扣 1 分（2 倍速），
//      现在不足 1 分的存进 decayDebt，攒够再扣，速率才是参数写的那个数。
const FIRST_DECAY_CAP_DAYS = 1;

export function decayAll(now = Date.now()) {
  const store = readStore();
  let changed = 0;
  const cold = [];
  for (const raw of store.items) {
    const it = normalize(raw);
    if (it.status === "cold" || it.status === "superseded" || it.pinned) continue;
    const rate = RATE[it.layer] ?? 0;
    if (!rate) continue;
    // 「多久没结算过」：只认 lastDecayAt，没结算过的从入库时刻算
    const anchor = it.lastDecayAt || it.createdAt || now;
    let days = (now - anchor) / 86400000;
    if (it.lastDecayAt === 0) days = Math.min(FIRST_DECAY_CAP_DAYS, days); // 首轮封顶
    if (days <= 0) continue;
    const beforeScore = it.score;
    const beforeLayer = it.layer;
    const beforeStatus = it.status;
    // 攒零头：应扣的分先记成小数，攒够 1 分才真扣，这样 long 的 0.5/天 才真是 0.5
    const owed = it.decayDebt + rate * days;
    const drop = Math.floor(owed);
    it.decayDebt = Math.round((owed - drop) * 1000) / 1000;
    if (drop > 0) it.score = Math.max(FLOOR[it.layer] ?? 1, it.score - drop);
    it.layer = layerOf(it.score);
    if (it.score < COLD_BELOW) {
      it.status = "cold";
      it.layer = "short";
      cold.push(it.text.slice(0, 24));
    }
    // 结算锚点前移（**不碰 updatedAt**：那个字段的意思是「内容最后被动过」，
    // 被淡忘降了分不等于内容变了，混用就是这次这个 bug 的来源）
    it.lastDecayAt = now;
    Object.assign(raw, normalize(it));
    // 分数降了也要落盘：只在换层时写的话，分数变了文件里还是旧分，
    // 面板和提示词排序会一直滞后（2026-10-23 修）。
    if (beforeScore !== it.score || beforeLayer !== it.layer || beforeStatus !== it.status) changed++;
  }
  if (changed) writeStore(store);
  return { changed, cold };
}

// 时间戳：让她看一条就知道「这事离现在多久了」。
// 格式【10-20·3天前】；不是今年的带上年份【2024-12-31·10个月前】。
// 2026-10-21 主人要的：每段前加时间戳，对时间有感知。
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
// opts.allKeys = true 时不再只看本会话 + 共用那几页，所有会话的记性都进候选（2026-10-22 主人要的「全解开」）；
// 排序照样先按分数，所以本会话和共用块自然排在前面，别的群、私聊的排在后面。
export function buildBlocks(key, opts = {}) {
  // 每条前面多了个十来字的时间戳，上限相应放宽一点（不至于把内容挤掉）
  //
  // 【2026-10-26 主人拍的 B 档：mid 750→1500、short 500→1500】
  // 为什么不是改分配算法——实测过，**上限由 cap 决定，不由 take() 的分配策略决定**：
  //   · 试「每条最多占层容量 1/3、1/2」的截断策略：short 由 1 条变 2 条、总字数反而 −161，
  //     合计只多 1 条（39→40）；因为 short 那两条当天小结各 1200 字，怎么也塞不进 500。
  //   · 提 cap 到 1500：mid 7→15 条（+734 字）、short 1→2 条（+1000 字），
  //     合计 **多进 11 条 / 1884 字**。
  // 成本实测：+1225 tok/次拼装 ≈ 日成本 +7.9%（按每轮 3.52 步、缓存命中 88% 折算）。
  // core/long 不动：core 只用 419/1200（装得下），long 848/850 是刚好压满，提到 1000 只多 2 条。
  const caps = { core: 1200, long: 850, mid: 1500, short: 1500, ...(opts.caps || {}) };
  const store = readStore();
  const mine = store.items
    .map(normalize)
    .filter(
      (x) =>
        x.status !== "cold" &&
        x.status !== "superseded" && // 被顶掉的旧说法不进提示词
        (opts.allKeys ? true : x.key === key || x.key === "shared"),
    )
    // 分数一样的先排本会话的（共用的其次），别让别的群的旧事挤掉自己的
    .sort(
      (a, b) =>
        b.score - a.score ||
        ownRank(a.key, key) - ownRank(b.key, key) ||
        // 【2026-10-27 结论：短期层同分时**不要**改成「晚的在前」】
        // 拆行以后同一天的 5~6 块分数完全一样（都是 40），它们的 updatedAt 又都继承自
        // 原来那条整篇、彼此相同，排序确实退化成「谁在数组里靠前谁先进」。
        // 我一度想改成按行号倒序（后发生的事优先），但看了小结文件的实际结构就撤回了：
        // 她写小结时**第一行常是「还欠着…」这类未结事项**（例：10-24 首行就是
        // 「还欠着：昨晚 22:25、23:28 丢的两轮找不回」）。倒序会正好把这条挤出 cap，
        // 等于让她把没办完的事忘掉。维持按原顺序（从当天开头）截断更安全。
        b.updatedAt - a.updatedAt,
    );
  const used = [];
  const take = (layer, cap) => {
    let out = "";
    for (const it of mine) {
      if (it.layer !== layer) continue;
      // 2026-10-21 主人要的：永久层不带时间戳——「不知道什么时候记的，但很重要」
      const stamp = layer === "core" ? "" : stampOf(it.day);
      // 全解开以后，别的群/私聊的事也进来了：标一下来处，免得把群 A 的事当成群 B 的
      const from = opts.allKeys ? whereOf(it.key, key) : "";
      // 出处（2026-10-23 加的）：只有「单独存在 cite 字段、正文里还没写」的才补一句，
      // 免得一条记住两遍；查不出来的空着，不拿「未核实」占字数。
      const src =
        it.cite && it.cite !== "未核实" && !it.text.includes("〔源：")
          ? `〔源：${it.cite}〕`
          : "";
      // 一条太长就截断，别整条跳过（当天小结常常就很长）
      const room = cap - out.length - stamp.length - from.length - src.length - 4;
      if (room < 24) break;
      const body = it.text.length > room ? `${it.text.slice(0, room - 1)}…` : it.text;
      out += `- ${from}${stamp}${body}${src}\n`;
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

// 从「已经挂好出处的正文」里把出处抽出来（2026-10-23 修）
// 背景：日子账和小结在落盘前已经由 bot/cite.mjs 的 attachSources 挂过 〔源：…〕，
// 但进记忆库时只带了正文，cite 字段一直是空的——全库 89 条 cite 为空就是这个原因。
// 这里把标记抽出来经 resolveCite 核一遍，核得上的填进 cite，核不上就留空（不拿核不上的充数）。
function pickCite(key, day, text) {
  const raw = String(text ?? "");
  const stripped = cite.stripCites(raw);
  const list = cite.extractCites(raw);
  if (!list.length) return { cite: "", citeKind: "", body: raw, stripped };
  const home = path.dirname(storeDir || ".");
  const ctx = { home, archiveDir: path.join(home, "archive"), key, day };
  const good = [];
  const kinds = new Set();
  for (const c of list) {
    try {
      const v = cite.resolveCite(ctx, c);
      if (!v.ok) continue;
      good.push(c);
      kinds.add(v.kind);
    } catch {
      /* 核不了就当没有 */
    }
  }
  if (!good.length) return { cite: "", citeKind: "", body: raw, stripped };
  // 2026-10-27（A5）：「指得到」之后再核一道「对得上」。
  // resolveCite 只证明那个钟点/那天的文件真的存在；它不证明这条结论出自那里。
  // 判据用 cite.checkFacts（可核事实 = 数字/英文串/引号内原话），
  // 实测真实条目 95.8% 判「对得上」、整条编造能抓 93.8%。
  // 核不上**不删出处**（出处本身是真的），只把 citeKind 降成 "mismatch"，
  // 由 A1 的来源置信（CONF_BY_KIND.mismatch = 0.2）在检索时轻微压它。
  // 这样一次判定的结果会一直带着走，事后也能靠 citeKind 查出来。
  let kind = (kinds.size === 1 ? [...kinds][0] : "mixed").slice(0, 12);
  try {
    const dayText = cite.dayArchiveText(ctx);
    const chk = cite.checkFacts(stripped, dayText);
    // 判不上就记成 mismatch。**这里不写日志**：memory-store 没有自己的 logger，
    // 想查「哪条被判对不上」直接 `grep '"citeKind":"mismatch"' home/memory/store.json`，
    // 条目本身立刻能看见，比翻日志更直接。
    if (!chk.ok) kind = "mismatch";
  } catch {
    /* 核不了就当没核过，不改变原有判定 */
  }
  return {
    cite: [...new Set(good)].join("、").slice(0, 120),
    citeKind: kind.slice(0, 12),
    body: stripped,
    stripped,
  };
}

// 一天结出来的要点进中期；同一天同一条不重复
export function addDayNotes(key, day, bullets, score = 62) {
  return upsertMany(
    (bullets || []).map((b) => {
      const line = String(b)
        .replace(/^[-·•]\s*/, "")
        .trim();
      // 这些要点是 whale-bot 先 cite.attachSources 挂好出处再交过来的，
      // 以前整行原样当正文塞进库，出处留在字里行间没进 cite 字段。
      const picked = pickCite(key, day, line);
      return {
        key,
        layer: "mid",
        score,
        day,
        source: "ledger",
        // 正文一律去掉 〔源：…〕 标记（含标了「未核实」的）：出处已经单独存在 cite 字段里了，
        // 留着标记会让这条正文跟后面某次 attachSources 重复挂一遍，也会拿假出处配真结论。
        text: picked.stripped.trim(),
        cite: picked.cite,
        citeKind: picked.citeKind,
        tags: [],
      };
    }),
  );
}

// 当天小结：同一会话同一个日期，按「一件事一条」存。
//
// 【2026-10-27 修 D1：原来整篇小结压成一条】
// 旧行为把 1200 字的当天小结整条塞进库，而 short 层的 cap 是 1500 字——
// **一条就占了 80%，短期层等于只能装得下一条**。实测：short 层 9 条里 6 条是当天小结，
// 每条 1200 字，一次提示词只装得进 1~2 条，剩下的全被截断。
// 改成按行拆（小结文件本来就是「一件事一行」）：实测 5 行的小结拆成 5 条、
// 平均 240 字，1600 字的 cap 能装进 6 条左右。
// 这也和向量库的口径对齐了——那边早就按 320 字切块，理由是「一件事一块才查得准」，
// 记忆库这边一直是整篇糊成一坨。
export function setSessionShort(key, day, text) {
  const store = readStore();
  const base = `short:${key}:${day}`;
  // 小结文件是「- 」行格式；进库时去掉行首符号和空行
  const lines = String(text || "")
    .split("\n")
    .map((l) => l.replace(/^[-*·•]\s*/, "").trim())
    .filter((l) => l && !/^[-–—]$/.test(l));
  // 每行截到 600 字：单行再长就该自己拆了，但别让一行把整层 cap 吃掉
  //
  // 【2026-10-27 补：还要按句号二次拆】
  // 光按「行」拆不够——实测旧的 10-24/10-25 两天小结各是**一整行 1200 字**（不是多行），
  // 拆完还是一条 600 字的巨块，加上排序里它分高（42）排在最前，照样独占 40% 的 short cap。
  // 而且「一件事一块」这个理由对句子同样成立：1200 字的行里本来就有七八件事。
  // 所以对超长的行再按「。」「；」切成句子段、拼到 ~260 字一块为止
  // （260 是向量库那边的切块口径，对齐了检索才好命中）。
  const rawParts = lines.flatMap((l) => {
    if (l.length <= 320) return [l];
    const sents = l.split(/(?<=[。；！？])/).filter(Boolean);
    const out = [];
    let cur = "";
    for (const s of sents) {
      if (cur && cur.length + s.length > 300) {
        out.push(cur);
        cur = s;
      } else cur += s;
    }
    if (cur) out.push(cur);
    return out;
  });
  const parts = rawParts.map((l) => l.slice(0, 320)).filter((l) => l.length >= 4);
  // 一条都没有就什么都不做（别把空小结写成一条空记忆）
  if (!parts.length) return null;
  // 【2026-10-27 补：当天小结的分数要随日期递减】
  // 原来是写死 40，可旧的小结一旦被 touch 过就会爬上去（实测 10-24 那批到了 42），
  // 而 42 > 40 → **旧小结永远压在今天的前面**，short 层 cap 只有 1500 字，
  // 全被三天前的事占满，今天发生的事一条都进不去。这跟「短期层该记住最近」正好相反。
  // 所以按「离今天几天」给分：今天是 40，每老一天 −2，最低 30。
  // 这样新的一天天然排在前面，旧的自然往后沉，不需要额外排序逻辑。
  const baseScore = (() => {
    const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day || ""));
    if (!d) return 40;
    const dayMs = Date.UTC(+d[1], +d[2] - 1, +d[3]);
    const now = new Date();
    const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    // 用 UTC 日期对齐（day 本身就是北京逻辑日，两边都按「日」取整，差几小时不影响排序）
    const ageDays = Math.round((todayMs - dayMs) / 86400000);
    return Math.max(30, 40 - Math.max(0, ageDays) * 2);
  })();
  // 逐行挂着出处：小结每行本来就带 〔源：…〕（whale-bot 写文件前挂过），
  // 位置就是逐句的，一行一处比整篇并成一句更准。
  const nowItems = parts.map((body, i) => {
    const picked = pickCite(key, day, body);
    return {
      id: `${base}#${i}`,
      key,
      layer: "short",
      score: baseScore,
      day,
      source: "short",
      text: body,
      cite: picked.cite,
      citeKind: picked.citeKind,
    };
  });
  // 旧的整篇一条（id 没有 #n）：这次重写时删掉，它是拆分前的形态，
  // 留着会和新拆出来的行重复计入 cap，等于白占地方。
  store.items = store.items.filter((x) => x.id !== base);
  const nowById = new Map(nowItems.map((x) => [x.id, x]));
  // 已经存在的行：保留 createdAt（入库时刻才是真实的年龄锚点）和 lastDecayAt
  for (const raw of store.items) {
    const old = nowById.get(raw.id);
    if (!old) continue;
    old.createdAt = Number(raw.createdAt) || 0;
    old.lastDecayAt = Number(raw.lastDecayAt) || 0;
    old.decayDebt = Number(raw.decayDebt) || 0;
    old.injected = Number(raw.injected) || 0;
  }
  const existing = new Set(store.items.map((x) => x.id));
  for (const item of nowItems) {
    if (!item.createdAt) delete item.createdAt; // 新的行，让 normalize 填 now
    const norm = normalize({
      ...item,
      // 【2026-10-27 修 D2】44 封顶：mid 线是 45，卡在 44 就永远待在短期层。
      // 当天小结是「今天的事」，不该因为被想起几回就升格成长期结论。
      score: Math.min(DAILY_SHORT_MAX, 40),
    });
    if (existing.has(norm.id)) {
      const idx = store.items.findIndex((x) => x.id === norm.id);
      store.items[idx] = norm;
    } else store.items.push(norm);
  }
  // 只留最近 3 天的当天小结（按 day 分组，不再按条数——
  // 现在是「一天多行」，按条数留会把某一天的行切掉一半）
  const shorts = store.items.filter((x) => x.id.startsWith(`short:${key}:`));
  const days = [...new Set(shorts.map((x) => String(x.day || "")))].sort().reverse().slice(0, 3);
  const keepDay = new Set(days);
  const drop = new Set(shorts.filter((x) => !keepDay.has(String(x.day || ""))).map((x) => x.id));
  if (drop.size) store.items = store.items.filter((x) => !drop.has(x.id));
  writeStore(store);
  return nowItems[0] || null;
}

// ---------- 每晚巩固（2026-10-23）----------
// 一个会话某一天还活着的条目：夜里拿这些压结论、判撞车。
export function dayItems(key, day) {
  const k = canonKey(key);
  return readStore()
    .items.map(normalize)
    .filter((x) => x.key === k && x.status === "active" && (!day || x.day === day))
    .sort((a, b) => b.score - a.score);
}

// 现有的长期/永久条目：模型要压进哪条，就把 id 写进 merge（旧的会被标 superseded）
export function stableItems(key, limit = 24) {
  const k = canonKey(key);
  return readStore()
    .items.map(normalize)
    .filter((x) => x.key === k && x.status === "active" && (x.layer === "long" || x.layer === "core"))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// 巩固结果落地：新结论照常走 upsert（照样过合并那三道关），
// merge 里的旧条目标 superseded（留版本不删），links 挂上互联。
export function applyConsolidation(key, day, list = []) {
  const out = { added: 0, merged: 0, superseded: 0, linked: 0 };
  for (const c of Array.isArray(list) ? list : []) {
    const text = String(c?.text ?? "").trim();
    if (text.length < 4) continue;
    const it = upsert({
      key,
      text,
      score: Number(c.score) || 74,
      day: c.day || day,
      source: "consolidate",
      cite: c.cite || "",
      tags: Array.isArray(c.tags) ? c.tags : [],
    });
    if (it._op === "merged") out.merged += 1;
    else out.added += 1;
    for (const oldId of Array.isArray(c.merge) ? c.merge : []) {
      if (!oldId || oldId === it.id) continue;
      // 短期的条目不给夜里顶掉（2026-10-23 主人定的）：短期该等第二天压小结，不该被并走
      const old = getItem(oldId);
      if (old && old.layer === "short") continue;
      if (supersede(oldId, it.id)) out.superseded += 1;
    }
    for (const lid of Array.isArray(c.links) ? c.links : []) {
      if (!lid || lid === it.id) continue;
      link(it.id, lid);
      out.linked += 1;
    }
  }
  return out;
}

