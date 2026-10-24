// 用户画像（2026-10-24 主人要的）：一个真人一份，文件名「昵称-【QQ号】」，QQ 号是稳定键。
//
// 为什么要单独做：现在的记忆库是「事件账本」——EXTRACT_PROMPT 只挑「以后再也不会变、以后
// 还用得上」的事实，还要求每条照抄出处。结果 39 条私聊记忆里 20 条是「我/系统」的运维事，
// 真正关于主人的只有 11 条，而且全是原子事实（称呼、生日、在上学）。没有任何地方在归纳
// 「他一般几点醒、他烦什么、他说话什么调」这类需要跨天累计才看得出来的东西。
//
// 所以画像分两层，各用各的手段：
//   1. 节律（本地统计）——从 archive/*.jsonl 直接算，零成本、可回溯全量、每晚重算。
//      「他常凌晨两点还醒着」这种东西统计比模型准得多，也不该花模型的钱去猜。
//   2. 是谁 / 在乎什么 / 最近（模型归纳）——每晚一次批量调，只喂统计 + 少量原话样本，
//      一次写完所有人（分批调 16 次太慢也容易忘）。
//
// 改名：文件名带昵称，所以昵称变了要改名；但身份认 QQ，曾用名全留在文件里。
import fs from "node:fs";
import path from "node:path";

let DIR = "";
let INDEX_PATH = "";

export function initUserProfile(homeDir) {
  DIR = path.join(homeDir, "画像");
  INDEX_PATH = path.join(DIR, "_索引.json");
  try {
    fs.mkdirSync(DIR, { recursive: true });
  } catch {
    /* 建不了就算了，后面每次写都会再试并记日志 */
  }
  return DIR;
}

export const profileDir = () => DIR;

// ---------- 小工具 ----------

const readTextSafe = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/** 只读文件末尾 maxBytes，别为了看最后几条消息把几 MB 的档案全读进来。 */
function readTail(file, maxBytes = 65536) {
  try {
    const fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    let s = buf.toString("utf8");
    if (start > 0) {
      // 从中间切进来的第一行必然是残行，丢掉
      const i = s.indexOf("\n");
      if (i >= 0) s = s.slice(i + 1);
    }
    return s;
  } catch {
    return "";
  }
}

const bj = (ts) => new Date((Number(ts) || 0) + 8 * 3600 * 1000);
const bjDay = (ts) => bj(ts).toISOString().slice(0, 10);
const bjHour = (ts) => bj(ts).getUTCHours();
const pad2 = (n) => String(n).padStart(2, "0");
const shortDate = (ts) => {
  const d = bj(ts);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
};

/** Windows 文件名里不能出现的字符，昵称里全可能有（emoji 尾巴、斜杠、引号）。 */
function safeName(nick, qq) {
  const s = String(nick ?? "")
    .replace(/[\\/:*?"<>|\u0000-\u001f\r\n\t]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return s || `QQ${qq}`;
}

/** 群消息行的形状：[群里 昵称(QQ) 说·没叫我] 正文 / [群里 昵称（群友·QQ) 说] 正文 */
const GROUP_RE = /^\[群里\s+([\s\S]+?)[（(](?:群友·)?(\d{5,12})[）)]\s*说(·没叫我)?\]\s?([\s\S]*)$/;

const archiveKeyOf = (key) => String(key ?? "").replace(/[^A-Za-z0-9_-]/g, "_");

// ---------- 统计（本地，零成本） ----------

/** 口癖词表：这些是「看出来像人话」的信号，比 n-gram 稳。 */
const TICS = [
  "草", "艹", "哈哈", "哈哈哈", "嘿嘿", "emmm", "emm", "呜呜", "啊这", "乐",
  "绷", "离谱", "好家伙", "难绷", "服了", "确实", "绝了", "寄", "233", "awa",
  "喵", "哦豁", "？？", "。。。", "笑死", "不是吧", "真的假的",
];

/** n-gram 里要扔掉的虚词，含这些字的二元组基本没信息量。 */
const STOP_CHARS = new Set(
  "的了是我你他她它们这那就都也很不没在有和说吗呢吧啊呀哦嗯个上下来去会要能对到得地着过还把被给让从向以为所如".split(
    "",
  ),
);

const NICK_SEEN_MAX = 6;

/**
 * 摘掉「不是他说的话」的部分：机器人塞的图片占位、贴纸、CQ 码、她自己的标记。
 * 档案里的原文长这样：
 *   [图片已存到本机：E:\…\in-<时间戳>.png] 这啥
 *   [贴纸:cat-hey.gif]
 *   [CQ:image,file=…]
 * 统计口癖和 n-gram 前必须清掉，否则「片已×384」这种会污染画像。
 */
function cleanForStats(text) {
  return String(text ?? "")
    .replace(/\[图片已存到本机：[^\]]*\]/g, " ")
    .replace(/\[贴纸:[^\]]*\]/g, " ")
    .replace(/\[CQ:[^\]]*\]/g, " ")
    .replace(/\[语音\][\s\S]*?\[\/语音\]/g, " ")
    .replace(/\[氛围[:：][^\]]*\]/g, " ")
    .replace(/\[演化[:：][^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 扫全部档案，按 QQ 聚合每个人的说话习惯。纯本地，一万五千行也就几十毫秒。
 * 返回 Map<qq, person>，person 里所有统计字段都算好，直接能排版。
 */
export function scanStats(homeDir, { ownerQq = 0 } = {}) {
  const archive = path.join(homeDir, "archive");
  const people = new Map();

  const ensure = (qq, nick) => {
    let p = people.get(qq);
    if (!p) {
      p = {
        qq,
        nicks: [],
        lastNick: "", // 档案里最后出现的那个昵称（改名后就是新名字）
        msgs: 0,
        hours: new Array(24).fill(0),
        weekdays: new Array(7).fill(0),
        days: new Set(),
        lens: [],
        run: 0, // 当前连发第几条
        burstMsgs: 0, // 连发里第 2 条及以后的消息数
        atHer: 0, // 点名 @ 她的条数
        mentions: 0, // 消息里带 @ 的总条数
        first: 0,
        last: 0,
        texts: [], // 抽样原话：撒在整个历史上，不只留最近（只留最近就看不见「以前什么样」）
        samples: [], // { ts, text } 均匀抽样，装进提示词
        sampleSeen: 0,
        groups: new Set(),
        tics: new Map(),
        grams: new Map(),
        qmarks: 0, // 问号/疑问语气
        excls: 0, // 感叹
        ellipsis: 0,
      };
      people.set(qq, p);
    }
    if (nick) {
      if (!p.nicks.includes(nick) && p.nicks.length < NICK_SEEN_MAX) p.nicks.push(nick);
      p.lastNick = nick; // 档案是按时间追加的，最后见到的就是最新昵称
    }
    return p;
  };

  // 主人的私聊：private_<qq>.jsonl 里 role=user 的全是他
  let ownerNick = "";
  const files = [];
  try {
    for (const n of fs.readdirSync(archive)) if (n.endsWith(".jsonl")) files.push(n);
  } catch {
    return people;
  }

  const feed = (p, rawText, ts) => {
    // 档案里的正文带着机器人自己塞的标记（[图片已存到本机：E:\…]），
    // 不摘掉的话 n-gram 会统计出「片已×384」「已存×384」这种纯噪声。
    const text = cleanForStats(rawText);
    p.msgs += 1;
    p.hours[bjHour(ts)] += 1;
    p.weekdays[bj(ts).getUTCDay()] += 1;
    p.days.add(bjDay(ts));
    p.lens.push(text.length);
    if (!p.first || ts < p.first) p.first = ts;
    if (!p.last || ts > p.last) p.last = ts;
    if (/[?？]/.test(text)) p.qmarks += 1;
    if (/[!！]/.test(text)) p.excls += 1;
    if (/…|\.{3,}|。{3,}/.test(text)) p.ellipsis += 1;
    const ats = text.match(/\[CQ:at[^\]]*\]|@\d{5,12}/g);
    if (ats) {
      p.mentions += 1;
      if (ats.some((a) => a.includes("1000000006"))) p.atHer += 1;
    }
    for (const t of TICS) {
      if (text.includes(t)) p.tics.set(t, (p.tics.get(t) ?? 0) + 1);
    }
    const cjk = text.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
    for (const run of cjk) {
      for (let i = 0; i + 2 <= run.length; i += 1) {
        const g = run.slice(i, i + 2);
        if (STOP_CHARS.has(g[0]) || STOP_CHARS.has(g[1])) continue;
        p.grams.set(g, (p.grams.get(g) ?? 0) + 1);
      }
    }
    // 抽样要均匀撒在整个历史上：只留最近 40 条的话，装满了就永远只剩开头那几天
    if (text.length >= 4) {
      if (p.sampleSeen % 11 === 0 && p.samples.length < 60) {
        p.samples.push({ ts, text: text.slice(0, 160) });
      }
      p.sampleSeen += 1;
    }
  };

  for (const f of files) {
    const isPrivate = f.startsWith("private_");
    const gid = isPrivate ? "" : f.replace(/^group_/, "").replace(/\.jsonl$/, "");
    const fileQq = isPrivate ? f.replace(/^private_/, "").replace(/\.jsonl$/, "") : "";
    const raw = readTextSafe(path.join(archive, f));
    if (!raw) continue;
    let prevQq = "";
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.role !== "user") {
        prevQq = ""; // 她自己说了一句，连发就断了
        continue;
      }
      let qq = "";
      let nick = "";
      let text = String(o.text ?? "");
      if (isPrivate) {
        qq = fileQq;
      } else {
        const m = GROUP_RE.exec(text);
        if (!m) continue;
        nick = m[1].trim();
        qq = m[2];
        text = m[4] ?? "";
      }
      if (!qq) continue;
      const p = ensure(qq, nick);
      if (gid) p.groups.add(gid);
      if (isPrivate && !ownerNick) ownerNick = nick;
      // 连发：同一个人连着说，第 2 条起算「一口气补话」
      if (prevQq === qq) {
        p.burstMsgs += 1;
      } else {
        p.run = 0;
      }
      p.run += 1;
      prevQq = qq;
      feed(p, text, Number(o.ts) || 0);
    }
  }

  if (ownerQq) {
    const p = people.get(String(ownerQq));
    // 私聊文件名的号码就是主人；昵称从群名片里补一个（私聊档案里没有昵称）
    if (p && !p.nicks.length) {
      const gn = readGroupNicks(homeDir).get(String(ownerQq));
      if (gn) p.nicks.push(gn);
    }
  }

  // 收尾：p90 / 时段 / 词频排序
  // 昵称三处来源按新鲜度排：runtime/group-nicks.json（机器人随时在更新）> 档案里最后见到的 > 第一个。
  const liveNicks = readGroupNicks(homeDir);
  for (const p of people.values()) {
    p.lens.sort((a, b) => a - b);
    const n = p.lens.length;
    p.p50 = n ? p.lens[Math.floor(n * 0.5)] : 0;
    p.p90 = n ? p.lens[Math.min(n - 1, Math.floor(n * 0.9))] : 0;
    p.burstRate = p.msgs ? p.burstMsgs / p.msgs : 0;
    p.topHours = [...p.hours.entries()]
      .filter(([, c]) => c > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3);
    p.topTics = [...p.tics.entries()].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]).slice(0, 6);
    const gramFloor = Math.max(3, Math.round(p.msgs * 0.03));
    p.topGrams = [...p.grams.entries()]
      .filter(([, c]) => c >= gramFloor)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([g, c]) => `${g}×${c}`);
    const live = liveNicks.get(p.qq);
    if (live && !p.nicks.includes(live)) p.nicks.unshift(live);
    p.nick = live || p.lastNick || p.nicks[0] || `QQ${p.qq}`;
  }

  return people;
}

/** runtime/group-nicks.json：QQ → 群名片（781 条，机器人自己攒的）。 */
export function readGroupNicks(homeDir) {
  const m = new Map();
  try {
    const d = JSON.parse(
      fs
        .readFileSync(path.join(homeDir, "..", "runtime", "group-nicks.json"), "utf8")
        .replace(/^\uFEFF/, ""),
    );
    for (const [k, v] of Object.entries(d ?? {})) {
      if (/^\d{5,12}$/.test(k) && v) m.set(k, String(v));
    }
  } catch {
    /* 没有就空着 */
  }
  return m;
}

/** 统计转成人能读的几行（进画像的「节律」一节，也进提示词给模型看）。 */
export function statLines(p) {
  const out = [];
  out.push(
    `消息 ${p.msgs} 条，活跃 ${p.days.size} 天，最早 ${shortDate(p.first)}，最近 ${shortDate(p.last)}`,
  );
  if (p.topHours.length) {
    const total = p.hours.reduce((a, b) => a + b, 0) || 1;
    out.push(
      `常出没：${p.topHours
        .map(([h, c]) => `${pad2(h)}-${pad2((h + 1) % 24)} 点（${Math.round((c / total) * 100)}%）`)
        .join("、")}`,
    );
  }
  const wk = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const wkTop = p.weekdays.map((c, i) => [wk[i], c]).sort((a, b) => b[1] - a[1]);
  if (wkTop[0]?.[1] > 0) out.push(`一周里 ${wkTop[0][0]} 话最多（${wkTop[0][1]} 条）`);
  out.push(
    `说话长度：一半不到 ${p.p50} 字，长句 p90 ${p.p90} 字；一口气连发（第 2 条起）占 ${Math.round(p.burstRate * 100)}%`,
  );
  const marks = [];
  if (p.qmarks / Math.max(1, p.msgs) > 0.15) marks.push("爱反问");
  if (p.excls / Math.max(1, p.msgs) > 0.15) marks.push("爱感叹");
  if (p.ellipsis / Math.max(1, p.msgs) > 0.15) marks.push("常带省略号");
  if (marks.length) out.push(`标点习惯：${marks.join("、")}`);
  if (p.topTics.length) out.push(`口癖：${p.topTics.map(([t]) => t).join("、")}`);
  if (p.topGrams.length) out.push(`常说的词：${p.topGrams.join("、")}`);
  if (p.atHer > 0) out.push(`点名 @ 过她 ${p.atHer} 次`);
  if (p.groups.size) out.push(`在群里：${[...p.groups].join("、")}`);
  return out;
}

// ---------- 索引与文件 ----------

export function readIndex() {
  try {
    const d = JSON.parse(readTextSafe(INDEX_PATH) || "{}");
    if (d && typeof d.people === "object" && d.people) return d;
  } catch {
    /* 索引坏了就当空的，下次重建 */
  }
  return { version: 1, updatedAt: 0, people: {} };
}

function writeIndex(idx) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${INDEX_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(idx, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, INDEX_PATH);
  } catch {
    /* 索引写失败不影响画像正文 */
  }
}

export const pageFile = (nick, qq) => `${safeName(nick, qq)}-【${qq}】.md`;

/** 从画像正文里把「是谁 / 在乎什么 / 最近」三节的要点抽回来（重写时当旧稿喂给模型）。 */
function parseSections(md) {
  const secs = { who: [], care: [], recent: [] };
  if (!md) return secs;
  const nameMap = [
    ["who", /^##\s*(他|她)?是谁/m],
    ["care", /^##\s*好在乎什么/m],
    ["recent", /^##\s*最近/m],
  ];
  let cur = null;
  for (const line of md.split("\n")) {
    const t = line.trim();
    const hit = nameMap.find(([, re]) => re.test(t));
    if (hit) {
      cur = hit[0];
      continue;
    }
    if (/^##\s/.test(t)) {
      cur = null;
      continue;
    }
    if (cur && /^[-·•]\s*\S/.test(t)) secs[cur].push(t.replace(/^[-·•]\s*/, ""));
  }
  return secs;
}

/** 一页画像的正文：模型三节在前，自动统计垫底。 */
function renderPage(meta, analysis, stats) {
  const lines = [`# ${meta.nick}（QQ ${meta.qq}）`, ""];
  const alias = (meta.aliases ?? []).filter((a) => a && a !== meta.nick);
  lines.push(
    `<!-- profile ${JSON.stringify({ qq: meta.qq, nick: meta.nick, aliases: alias, msgs: meta.msgs, updatedAt: meta.updatedAt })} -->`,
    "",
  );
  if (alias.length) lines.push(`> 曾用名：${alias.join("、")}（认号不认名，改昵称不影响）`, "");
  const sec = (title, items, empty) => {
    lines.push(`## ${title}`, "");
    if (items?.length) for (const it of items) lines.push(`- ${it}`);
    else lines.push(empty);
    lines.push("");
  };
  sec("他是谁", analysis.who, "（还没归纳出来，等每晚重算）");
  sec("好在乎什么", analysis.care, "（还没归纳出来）");
  sec("最近", analysis.recent, "（这段时间没什么新变化）");
  lines.push("## 节律（自动统计 · 每晚重算，不用模型）", "");
  for (const s of stats) lines.push(`- ${s}`);
  lines.push("");
  return lines.join("\n");
}

/** 用统计刷新所有候选人的「节律」一节，模型三节保留原样。零成本、可随时跑。 */
export function rebuildLocal(homeDir, { ownerQq = 0, minMsgs = 40 } = {}) {
  if (!DIR) initUserProfile(homeDir);
  const stats = scanStats(homeDir, { ownerQq });
  const idx = readIndex();
  const made = [];
  const renamed = [];
  for (const p of stats.values()) {
    const isOwner = ownerQq && String(ownerQq) === p.qq;
    if (!isOwner && p.msgs < minMsgs) continue;
    const nick = p.nick || `QQ${p.qq}`;
    const file = pageFile(nick, p.qq);
    const old = idx.people[p.qq];
    const oldFile = old?.file && path.join(DIR, old.file);
    const target = path.join(DIR, file);
    let md = "";
    // 改昵称：旧文件改名到新名字，内容跟着走（QQ 是身份，昵称只是标签）
    if (old?.file && old.file !== file && oldFile && fs.existsSync(oldFile)) {
      try {
        if (!fs.existsSync(target)) fs.renameSync(oldFile, target);
        else md = readTextSafe(target);
        renamed.push(`${old.file} -> ${file}`);
      } catch {
        /* 改名失败就下次再试 */
      }
    }
    md = readTextSafe(target) || md;
    const prev = parseSections(md);
    const aliases = [...new Set([...(old?.aliases ?? []), ...p.nicks, ...(old?.nick ? [old.nick] : [])])];
    const meta = {
      qq: p.qq,
      nick,
      aliases,
      msgs: p.msgs,
      updatedAt: Date.now(),
    };
    const body = renderPage(meta, prev, statLines(p));
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(target, body, "utf8");
      made.push(file);
    } catch {
      continue;
    }
    idx.people[p.qq] = {
      qq: p.qq,
      nick,
      aliases,
      file,
      msgs: p.msgs,
      lastAt: p.last,
      groups: [...p.groups],
      digest: (old?.digest ?? "").slice(0, 200),
      analyzedAt: old?.analyzedAt ?? 0,
    };
  }
  idx.updatedAt = Date.now();
  writeIndex(idx);
  return { count: made.length, made, renamed, dir: DIR };
}

/** 挑出这一夜要重算的人：够活跃的（含主人）。 */
export function candidates(homeDir, { ownerQq = 0, minMsgs = 40 } = {}) {
  const stats = scanStats(homeDir, { ownerQq });
  const out = [];
  for (const p of stats.values()) {
    const isOwner = ownerQq && String(ownerQq) === p.qq;
    if (!isOwner && p.msgs < minMsgs) continue;
    out.push(p);
  }
  out.sort((a, b) => (ownerQq && String(ownerQq) === b.qq ? 1 : 0) - (ownerQq && String(ownerQq) === a.qq ? 1 : 0) || b.msgs - a.msgs);
  return out;
}

/** 批量归纳的提示词：一次问完所有人，省得到点连打十几次模型。 */
export function refreshPrompt(people, { ownerQq = 0, existing = {}, maxSamples = 16 } = {}) {
  const blocks = people.map((p, i) => {
    const old = existing[p.qq];
    const oldText = old ? `- 旧稿：${old}` : "- 旧稿：（还没有）";
    // 抽样的条数还要再收一道：几十个人各带 60 条，一趟下来两万多字，太贵了。
    // 均匀隔几条取一条，保住时间跨度（只截前面就等于只看开头那几天）。
    const all = p.samples;
    const picked = [];
    const step = Math.max(1, Math.ceil(all.length / maxSamples));
    for (let k = 0; k < all.length && picked.length < maxSamples; k += step) picked.push(all[k]);
    const samples = picked
      .map((s) => `  · [${shortDate(s.ts)}] ${s.text.replace(/\n/g, " ")}`)
      .join("\n");
    return [
      `【${i + 1}】${p.nick}（QQ ${p.qq}）${ownerQq && String(ownerQq) === p.qq ? " ← 这是主人本人" : ""}`,
      `- 统计：${statLines(p).join("；")}`,
      oldText,
      "- 最近原话样本：",
      samples || "  · （没有）",
    ].join("\n");
  });
  return [
    "[系统安排 · 不是主人在说话]",
    "[这是每晚给每个人重算一次「画像」的内务活，不发给任何人。]",
    "[下面是统计数字和少量原话样本。按人归纳三件事，写成给「我」自己看的备忘录口吻（用「他」/「她」指代对方，不要用「你」）：]",
    "1. 他是谁：身份、和我的关系、在哪个群、什么作息、什么水平/行当。只写统计和原话支持得住的东西。",
    "2. 好在乎什么：他在意的事、烦什么、喜欢被怎么对待、和他说话要注意什么。",
    "3. 最近：这段时间的新变化（换了项目、退网、要考试、心情不好…）。没有就留空数组。",
    "[每条不超过 40 字，每类 1 到 3 条。不确定的宁可不写，别编。]",
    "[严格只回一个 JSON 数组，不要解释、不要代码块围栏：]",
    '[{"qq":"123456789","who":["…"],"care":["…"],"recent":["…"]}]',
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

/** 解析模型回的 JSON（容忍代码块围栏、单条对象、字符串代替数组）。 */
export function parseAnalysis(text) {
  let s = String(text ?? "").trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  let arr = null;
  if (a >= 0 && b > a) {
    try {
      arr = JSON.parse(s.slice(a, b + 1));
    } catch {
      arr = null;
    }
  }
  if (!arr) {
    const oa = s.indexOf("{");
    const ob = s.lastIndexOf("}");
    if (oa >= 0 && ob > oa) {
      try {
        const one = JSON.parse(s.slice(oa, ob + 1));
        arr = [one];
      } catch {
        arr = null;
      }
    }
  }
  if (!Array.isArray(arr)) return [];
  const asList = (v) =>
    (Array.isArray(v) ? v : [v])
      .flat()
      .map((x) => String(x ?? "").trim())
      .filter(Boolean)
      .map((x) => (x.length > 60 ? x.slice(0, 60) : x))
      .slice(0, 3);
  const out = [];
  for (const it of arr) {
    const qq = String(it?.qq ?? "").trim();
    if (!/^\d{5,12}$/.test(qq)) continue;
    out.push({ qq, who: asList(it.who), care: asList(it.care), recent: asList(it.recent) });
  }
  return out;
}

/** 把模型归纳写回各页（保留节律统计）。 */
export function applyAnalysis(homeDir, list, { ownerQq = 0, minMsgs = 40 } = {}) {
  if (!DIR) initUserProfile(homeDir);
  const stats = scanStats(homeDir, { ownerQq });
  const idx = readIndex();
  let n = 0;
  for (const it of list) {
    const p = stats.get(it.qq);
    if (!p) continue;
    const isOwner = ownerQq && String(ownerQq) === it.qq;
    if (!isOwner && p.msgs < minMsgs) continue;
    const nick = p.nick || `QQ${p.qq}`;
    const file = pageFile(nick, p.qq);
    const target = path.join(DIR, file);
    const prev = idx.people[it.qq];
    const aliases = [...new Set([...(prev?.aliases ?? []), ...p.nicks, ...(prev?.nick ? [prev.nick] : [])])].filter(Boolean);
    const meta = { qq: p.qq, nick, aliases, msgs: p.msgs, updatedAt: Date.now() };
    const use = {
      who: it.who.length ? it.who : parseSections(readTextSafe(target)).who,
      care: it.care.length ? it.care : parseSections(readTextSafe(target)).care,
      recent: it.recent.length ? it.recent : parseSections(readTextSafe(target)).recent,
    };
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(target, renderPage(meta, use, statLines(p)), "utf8");
    } catch {
      continue;
    }
    const digest = [use.who[0], use.care[0]].filter(Boolean).join("；").slice(0, 160);
    idx.people[p.qq] = {
      qq: p.qq,
      nick,
      aliases,
      file,
      msgs: p.msgs,
      lastAt: p.last,
      groups: [...p.groups],
      digest,
      analyzedAt: Date.now(),
    };
    n += 1;
  }
  idx.updatedAt = Date.now();
  writeIndex(idx);
  return n;
}

/** 给提示词用的一行人话：「萤（爸爸·1000000001）：…」。没有就返回空串。 */
export function digestOf(qq, { ownerQq = 0, group = false } = {}) {
  const idx = readIndex();
  const e = idx.people[String(qq)];
  if (!e) return "";
  // 群提示里 QQ 号会被 anonPiece 换成「昵称(群友·号)」，所以这里先写成成品：
  // 号前面带个「·」，anonPiece 的裸号替换有 (?<![\d·]) 的保护，不会再把昵称套两层。
  const owner = ownerQq && String(ownerQq) === String(qq);
  const label = group
    ? owner
      ? `爸爸·${e.qq}`
      : `群友·${e.qq}`
    : e.qq;
  const d = String(e.digest ?? "").trim();
  if (d) return `${e.nick}（${label}）：${d}`;
  // 还没被模型归纳过（第一晚之前）：退回「节律」那一节的头两条，
  // 总比一个字都不给强——她至少知道这个人什么时候出没、说话什么习惯。
  const md = e.file ? readTextSafe(path.join(DIR ?? "", e.file)) : "";
  const at = md.indexOf("## 节律");
  if (at < 0) return "";
  const rows = md
    .slice(at)
    .split("\n")
    .filter((l) => /^[-·•]\s*\S/.test(l.trim()))
    .slice(0, 2)
    .map((l) => l.trim().replace(/^[-·•]\s*/, ""));
  if (!rows.length) return "";
  return `${e.nick}（${label}）：${rows.join("；")}`;
}

/**
 * 这一轮该带上谁的画像。
 * 2026-10-25 主人改的规矩：**她正在回答谁的消息，就带谁的画像**。
 *   · 传了 qqs（这一轮说话的人）→ 就只带他们，主人在场也一并带上（最多 maxPeople 个）
 *   · 没传（主动搭话、写日记这种内部任务没有「谁」）→ 退回主人；群里实在没有就取最近说话的
 */
export function blockFor(homeDir, key, { ownerQq = 0, maxPeople = 3, qqs = null } = {}) {
  try {
    const idx = readIndex();
    if (!idx.people || !Object.keys(idx.people).length) return "";
    const isGroup = String(key ?? "").startsWith("group:");
    const picked = [];
    const push = (q) => {
      const s = String(q ?? "").trim();
      if (!/^\d{5,12}$/.test(s)) return;
      if (picked.includes(s)) return;
      if (picked.length >= maxPeople) return;
      picked.push(s);
    };
    if (Array.isArray(qqs) && qqs.length) {
      // 他本人在场就先说他，再补这一轮其他人
      if (ownerQq) push(ownerQq);
      for (const q of qqs) push(q);
    } else if (!isGroup) {
      if (ownerQq) push(ownerQq);
    } else {
      // 没有具体对象（内部任务）：从档案尾巴认最近说话的人
      // 2026-10-25 修：主人先占位，再补最近说话的群友。原来 push(ownerQq) 写在循环**之后**，
      // 群里最近有 ≥3 个人说过话时主人就被挤出去——与上面「他本人在场就先说他」正好相反。
      if (ownerQq) push(ownerQq);
      const file = path.join(homeDir, "archive", `${archiveKeyOf(key)}.jsonl`);
      const tail = readTail(file, 32768);
      const seen = new Set();
      const lines = tail.split("\n").filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && picked.length < maxPeople; i -= 1) {
        let o;
        try {
          o = JSON.parse(lines[i]);
        } catch {
          continue;
        }
        if (o.role !== "user") continue;
        const m = GROUP_RE.exec(String(o.text ?? ""));
        if (!m) continue;
        if (seen.has(m[2])) continue;
        seen.add(m[2]);
        push(m[2]);
      }
      // 原来这里还有一句 push(ownerQq)——挪到循环前之后就成了纯重复，删掉。
    }
    const rows = picked
      .map((q) => digestOf(q, { ownerQq, group: isGroup }))
      .filter(Boolean);
    if (!rows.length) return "";
    // 2026-10-25 主人定的：画像**只供参考**——它是夜里自己归纳的、可能写错，
    // 不是事实来源；跟人家说的话对不上，以对方当下说的为准，别拿画像去抬杠。
    return (
      "[画像 · 只供参考。这是夜里自己按统计和老原话猜的，可能过时或写错；" +
      "跟对方当场说的对不上，以他说的为准，别拿它给人贴标签]\n" +
      rows.map((r) => `- ${r}`).join("\n")
    );
  } catch {
    return "";
  }
}
