// 表情库（2026-10-25 A 层）：观澜自己的表情收藏，和 media 分开放，躲开 7 天清理。
//
// 为什么单独一个模块：三处调用方（收图 / 发表情 / 收藏夹同步）都要同一套读写，
// 写在 whale-bot.mjs 里又要复制三份，改一次漏两处——这是 2026-10-25 那次
// 「图片分支改了三处只改一处」的教训。
//
// 三条硬约束：
//  ① 目录 home\memes\ 不进 media，`pruneMedia()` 只扫 media 根，动不到这里；
//  ② 主键用 sha256 前 16 位，不信文件名——同一张表情在群里/私聊/收藏夹会出现三次，
//     文件名各不相同（实测 8b-8be2ea413a1f….gif 和 8BE2EA413A1F….gif 是同一张）；
//  ③ 索引坏了不能拖垮主流程：读失败一律当空库重新建，写失败只记日志不抛。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// 表情库目录结构
//   home\memes\index.json          索引
//   home\memes\<sha16>.<ext>       原件（内容寻址）
//   home\state\fav-backup-*.json   往收藏夹写之前的备份清单
export const MEME_INDEX_VERSION = 1;

const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;

// 按文件头认后缀，别信名字（QQ 常把 gif 报成 .png）
export function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return ".png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.toString("latin1", 0, 3) === "GIF") return ".gif";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return ".webp";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return ".bmp";
  return "";
}

/**
 * 从描述里切出关键词：中文二字滑窗 + 英文数字按词。
 * 用途只有一个——`[表情:猫]` 这种口语查询能命中。不追求准确率，命中率靠 desc 兜底。
 */
export function tagsFromText(text) {
  const t = String(text ?? "").normalize("NFKC").toLowerCase().trim();
  if (!t) return [];
  const out = new Set();
  // 整段（最长的那个标签，比如「xiexi您有钳」）
  if (t.length <= 12 && t.length >= 2) out.add(t);
  // 按分隔符切成词
  for (const w of t.split(/[\s\p{P}\p{S}]+/u)) {
    if (w && w.length >= 1 && w.length <= 12) out.add(w);
  }
  // 中文二字滑窗
  const cjk = t.replace(/[^\u3400-\u9fff]/g, "");
  for (let i = 0; i + 2 <= cjk.length; i++) out.add(cjk.slice(i, i + 2));
  return [...out];
}

// ---------- 从 desc 本地推 emotion（不调模型） ----------
// 2026-10-25 23:5x 主人拍板：那些「有准确 desc 但没 emotion」的条目，别再让模型读图重打，
// 直接从描述文字推——**desc 本来就是她读图写出来的，信息已经在那了，再读一遍纯浪费**。
// 实测 16 条需要推的 desc，用下面这套关键词能全部对上。
//
// 设计要点：
//   · 一张图可以有**两三个**情绪（「猫趴头上」→ 贴贴+开心），按顺序取前 3 个；
//   · 词表按「**先具体后笼统**」排：`流眼泪` 比 `哭` 优先命中，`中指/嘲讽` 比 `无语` 优先；
//   · 推不出来就返回空数组（**不硬凑**）——空 emotion 不是错，`pick()` 有三段降级兜底。
const DESC_EMOTION_RULES = [
  // 哭/难过类
  [[/流眼泪|眼泪|哭|委屈|难过|伤心|眼眶/], ["委屈", "难过"]],
  // 生气/崩溃类
  [[/气炸|咬|巴掌|拳|怒|凶|炸毛|抓狂/], ["生气", "崩溃"]],
  // 嘲讽/欠揍类
  [[/中指|嘲讽|欠|冷笑|哦？|哦\?/], ["嘲讽", "得意"]],
  // 无语/呆住类
  [[/面无表情|呆|木|空白|蠢脸|崩溃啦|脑子不存在|省略号|一动不动|发绿|糊到/], ["无语", "迷茫"]],
  // 迷茫/疑惑类
  [[/迷茫|我是谁|问号|不明白|疑惑|困惑|懵|抓不准/], ["迷茫", "疑惑"]],
  // 困/睡类
  [[/睡觉|睡着|趴桌上|趴着睡|困|打哈欠|冒热气/], ["困", "疲惫"]],
  // 偷瞄/害羞类
  [[/偷瞄|瞟|侧头|探头|偷看|脸颊|腮红/], ["害羞", "偷瞄"]],
  // 贴贴/亲密类
  [[/贴贴|叠在一起|趴在大猫|顶着|顶个|抱|捧|亲/], ["贴贴", "开心"]],
  // 开心/卖萌类
  [[/卖萌|吐舌|开心|笑|爱心|悟了|冒泡|举爪/], ["开心", "卖萌"]],
  // 单纯符号（感叹号/猫耳这种）
  [[/感叹号|注意丨注意/], ["无语"]],
  [[/猫耳|猫脸|喵/], ["卖萌", "可爱"]],
];

/** 从 desc 推情绪词，最多 3 个；推不出返回 []。 */
export function inferEmotionFromDesc(desc) {
  const t = String(desc ?? "");
  if (!t || t === "[动画表情]" || /^\[.*\]$/.test(t)) return [];
  const out = [];
  for (const [res, emos] of DESC_EMOTION_RULES) {
    if (!res.some((re) => re.test(t))) continue;
    for (const e of emos) if (!out.includes(e)) out.push(e);
    if (out.length >= 3) break;
  }
  return out.slice(0, 3);
}

export function createMemeLib({ homeDir, log = () => {} }) {
  const dir = path.join(homeDir, "memes");
  const indexPath = path.join(dir, "index.json");
  const stateDir = path.join(homeDir, "state");
  const backupDir = path.join(homeDir, "state");

  // ---------- 索引读写 ----------
  function emptyIndex() {
    return { v: MEME_INDEX_VERSION, items: {} };
  }

  function load() {
    try {
      const raw = fs.readFileSync(indexPath, "utf8").replace(/^\uFEFF/, "");
      const o = JSON.parse(raw);
      if (!o || typeof o !== "object" || !o.items || typeof o.items !== "object") return emptyIndex();
      // 兜底集中在这一处（拆分教训：默认值散到各处就会算出 undefined）
      for (const it of Object.values(o.items)) {
        if (!it || typeof it !== "object") continue;
        it.tags = Array.isArray(it.tags) ? it.tags : [];
        it.hits = Number.isFinite(Number(it.hits)) ? Number(it.hits) : 0;
        it.status = it.status === "stale" ? "stale" : "active";
        it.subType = Number(it.subType) === 1 ? 1 : 0;
        // emotion 兜底（2026-10-25）：老条目没有这个字段，统一补成空数组，
        // 别让下游 `it.emotion.includes(...)` 炸在 undefined 上。
        it.emotion = Array.isArray(it.emotion) ? it.emotion.map(String) : [];
        it.emotionAt = Number.isFinite(Number(it.emotionAt)) ? Number(it.emotionAt) : 0;
      }
      if (o.v !== MEME_INDEX_VERSION) o.v = MEME_INDEX_VERSION;
      return o;
    } catch {
      return emptyIndex(); // 没有索引文件 = 空库，不是错误
    }
  }

  let dirty = false;
  function save(idx) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(indexPath, JSON.stringify(idx, null, 0), "utf8");
      dirty = false;
    } catch (e) {
      log("表情库索引写失败:", e?.message ?? e);
    }
  }

  function ensureDir() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.mkdirSync(stateDir, { recursive: true });
      return true;
    } catch (e) {
      log("表情库建目录失败:", e?.message ?? e);
      return false;
    }
  }

  // ---------- 收：把一张图吸收进库 ----------
  /**
   * @param {string} srcPath 已有的图片绝对路径（带回车的都行，不在这里下载）
   * @param {object} o { source:"fav"|"owner"|"group"|"self", fromQq?, desc?, tags?[], subType? }
   * @returns {{key:string,file:string,isNew:boolean}|null}
   */
  function absorb(srcPath, o = {}) {
    try {
      if (!srcPath || !fs.existsSync(srcPath)) return null;
      const st = fs.statSync(srcPath);
      if (!st.isFile() || st.size <= 0) return null;
      if (st.size > 8 * 1024 * 1024) {
        log(`表情库：${path.basename(srcPath)} 超过 8MB，不入库`);
        return null;
      }
      const buf = fs.readFileSync(srcPath);
      const hash = createHash("sha256").update(buf).digest("hex").slice(0, 16);
      const idx = load();
      const old = idx.items[hash];
      if (old && old.file && fs.existsSync(path.join(dir, old.file))) {
        // 已存在：只更新见过的时间与来源，不重写文件（去重核心）
        old.lastSeen = Date.now();
        if (o.source && !old.sources?.includes(o.source)) {
          old.sources = [...new Set([...(old.sources ?? []), o.source])];
        }
        if (o.desc && !old.desc) old.desc = String(o.desc).slice(0, 60);
        if (o.fromQq && !old.fromQq) old.fromQq = o.fromQq;
        if (Number(o.subType) === 1) old.subType = 1;
        for (const t of o.tags ?? []) if (!old.tags.includes(t)) old.tags.push(t);
        save(idx);
        return { key: hash, file: old.file, isNew: false };
      }
      ensureDir();
      const ext = sniffImageExt(buf) || (IMG_EXT_RE.test(path.basename(srcPath)) ? path.extname(srcPath).toLowerCase() : ".png");
      const name = hash + ext;
      const dest = path.join(dir, name);
      let linked = false;
      try {
        // 同一块盘优先硬链：不占双份空间（media 与 memes 都在 home 下）
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        fs.linkSync(srcPath, dest);
        linked = true;
      } catch {
        linked = false;
      }
      if (!linked) fs.writeFileSync(dest, buf);
      const desc = String(o.desc ?? "").slice(0, 60);
      // desc 是空的/占位时**不要用它切词**（2026-10-25）：原来 `tagsFromText("[动画表情]")`
      // 会切出「动画 / 画表 / 表情」——「画表」是二字滑窗切错的产物，纯噪音，
      // 还会让 `[表情:表情]` 这种毫无意义的词命中一堆空壳。
      const descUsable = desc && desc !== "[动画表情]" && !/^\[.*\]$/.test(desc);
      idx.items[hash] = {
        file: name,
        ext,
        tags: [
          ...new Set([
            ...(o.tags ?? []),
            ...(descUsable ? tagsFromText(desc) : []),
          ]),
        ].slice(0, 24),
        desc,
        // emotion：这张**适合什么情绪**（2026-10-25 观澜原话「按当时的心情来挑，不要只认关键词」）。
        // 和 tags（长什么样）是两个正交维度：tags 是内容，emotion 是用途。
        // 入库时可以是空数组（还没读图），由 describeWorker 后续读图补上。
        emotion: Array.isArray(o.emotion) ? [...new Set(o.emotion.map(String))].slice(0, 4) : [],
        emotionAt: o.emotion ? Date.now() : 0, // 读图补 emotion 的时刻；0 = 还没补过
        sources: [...new Set([o.source ?? "self"])],
        fromQq: o.fromQq ?? null,
        subType: Number(o.subType) === 1 ? 1 : 0,
        addedAt: Date.now(),
        lastSeen: Date.now(),
        hits: 0,
        status: "active",
      };
      save(idx);
      return { key: hash, file: name, isNew: true };
    } catch (e) {
      log("表情入库失败:", e?.message ?? e);
      return null;
    }
  }

  // ---------- 情绪维度（2026-10-25，观澜原话「按当时的心情来挑，不要只认关键词」）----------
  // 为什么单独一层：`tags` 记的是**长什么样**（猫/绿发/咬牙），她想发的时候想的是
  // **这会儿什么情绪**（撒娇/无语/委屈）。两者正交，关键词那条路永远差一截。
  // 所以这里补 `emotion` 维度：`[表情:撒娇]` 先按 emotion 找，找不到才退回 tags。

  // 心情 → 偏好哪些情绪。阈值用 mood 的 0-100 直接分段，不引入新参数。
  // **只是默认值**：她显式写了情绪词就照她的来，这个只在 `[表情]` 空参数时用。
  const MOOD_PREF = [
    // [上界, 情绪列表]
    [15, ["委屈", "哭", "难过", "困", "低落"]],
    [40, ["无语", "疑惑", "迷茫", "尴尬", "叹气"]],
    [70, ["开心", "贴贴", "摸头", "乖", "微笑"]],
    [101, ["开心", "得意", "卖萌", "撒娇", "兴奋", "哈哈"]],
  ];

  // ---------- 口语情绪词 → 库里真有的 emotion 词（2026-10-26 加的） ----------
  // 为什么要有这张表：库里 47 张只有 23 张带 emotion，词也就十来个
  // （开心/卖萌/卖乖/贴贴/无语/迷茫/疑惑/委屈/难过/困/疲惫/生气/崩溃/嘲讽/得意/害羞/偷瞄/可爱）。
  // 我说话时的词更散（撒娇、乖、想哭、气死），直查对不上就整张不发——
  // 00:41 那条 `[表情:撒娇]` 就是这么漏成文字的。
  // 只做**直查落空后的折返**：原词命中就照原词走，不抢已有路径。
  const EMOTION_ALIASES = {
    撒娇: ["卖萌", "卖乖", "贴贴"],
    卖乖: ["卖萌", "开心"],
    乖: ["卖乖", "卖萌"],
    亲亲: ["贴贴"],
    抱抱: ["贴贴"],
    摸头: ["贴贴", "开心"],
    贴贴: ["贴贴"],
    哭: ["委屈", "难过"],
    哭哭: ["委屈", "难过"],
    想哭: ["委屈", "难过"],
    气死: ["生气", "崩溃"],
    哈哈: ["开心", "得意"],
    笑: ["开心", "卖萌"],
    开心: ["开心", "卖萌"],
    无语: ["无语", "迷茫"],
    疑惑: ["疑惑", "迷茫"],
    困: ["困", "疲惫"],
    羞: ["害羞", "偷瞄"],
  };

  /** 按心情给一组偏好情绪。mood 缺省时按「还行」处理。 */
  function emotionsForMood(mood) {
    const m = Number(mood);
    const v = Number.isFinite(m) ? m : 50;
    for (const [cap, list] of MOOD_PREF) if (v < cap) return list;
    return MOOD_PREF[MOOD_PREF.length - 1][1];
  }

  /**
   * 按情绪找一张（优先 emotion 字段，没有情绪数据的条目自动跳过）。
   * @param {string[]|string} emotions 想要的情绪，可给多个（按顺序优先）
   * @param {{mood?:number, excludeKeys?:string[]}} opts
   * @returns {{key:string,path:string,item:object}|null}
   */
  function findByEmotion(emotions, opts = {}) {
    try {
      const want = (Array.isArray(emotions) ? emotions : [emotions])
        .map((s) => String(s ?? "").normalize("NFKC").trim())
        .filter(Boolean);
      if (!want.length) return null;
      const idx = load();
      const exclude = new Set(opts.excludeKeys ?? []);
      const cands = [];
      for (const [key, it] of Object.entries(idx.items)) {
        if (it.status !== "active") continue;
        if (exclude.has(key)) continue;
        if (!Array.isArray(it.emotion) || !it.emotion.length) continue;
        const p = path.join(dir, it.file);
        if (!fs.existsSync(p)) continue;
        // 优先级 = 命中情绪在 want 里的位置（越靠前越高）
        let rank = -1;
        for (let i = 0; i < want.length; i++) {
          if (it.emotion.includes(want[i])) {
            rank = want.length - i;
            break;
          }
        }
        if (rank <= 0) continue;
        cands.push({ key, path: p, item: it, rank });
      }
      if (!cands.length) return null;
      // 同 rank 优先用得少的，再按新近（跟 find() 同一套规则，别老发同一张）
      cands.sort((a, b) => {
        if (a.rank !== b.rank) return b.rank - a.rank;
        const ha = Number(a.item.hits ?? 0);
        const hb = Number(b.item.hits ?? 0);
        if (ha !== hb) return ha - hb;
        return Number(b.item.addedAt ?? 0) - Number(a.item.addedAt ?? 0);
      });
      return { key: cands[0].key, path: cands[0].path, item: cands[0].item };
    } catch (e) {
      log("按情绪找表情失败:", e?.message ?? e);
      return null;
    }
  }

  /**
   * 统一入口：先按情绪，再按关键词，都没有就按心情随便挑一张。
   * 这是 `[表情:xxx]` / `[表情]` 唯一的调用点，改行为只改这里。
   * @param {{keyword?:string, mood?:number, excludeKeys?:string[]}} o
   */
  function pick(o = {}) {
    const kw = String(o.keyword ?? "").trim();
    if (kw) {
      // ① 先当情绪词试（「撒娇」「无语」「委屈」这类词 tags 里通常没有）
      const byEmo = findByEmotion([kw], { excludeKeys: o.excludeKeys });
      if (byEmo) return { ...byEmo, via: "emotion" };
      // ② 退回原来的关键词路（「猫」「您有钳」照旧能用——旧路径不动）
      const byKw = find(kw);
      if (byKw) return { ...byKw, via: "keyword" };
      // ③ 直查都没中，按**口语折返表**再试一轮（撒娇 → 卖萌/卖乖/贴贴 这类）
      for (const a of EMOTION_ALIASES[kw] ?? []) {
        const hit = findByEmotion([a], { excludeKeys: o.excludeKeys }) ?? find(a);
        if (hit) return { ...hit, via: `alias:${kw}→${a}` };
      }
      return null; // 都没找到就返回 null，由调用方决定原样留成文字
    }

    // ⚠️ 2026-10-25 修的一个设计缺陷：**库还没情绪数据时不能直接摆烂**。
    // 原实现走完 findByEmotion 全部落空就 return null，结果「[表情] 空参数」在
    // 情绪标签补齐之前**一张都发不出来**（实测测试库里 3 张全空 → 表情 0 张）。
    // 现在兜底顺序：情绪挑不到 → 退关键词挑（用 moods 里第一个词当 kw）→ 再退「用得最少的」。
    // 三段兜底的意图：**先按心情，挑不到就降级**，而不是「没数据就罢工」。
    // ③ 没给关键词：按当前心情挑（**默认值，不是强制**）
    const emos = emotionsForMood(o.mood);
    for (const e of emos) {
      const hit = findByEmotion([e], { excludeKeys: o.excludeKeys });
      if (hit) return { ...hit, via: `mood:${e}` };
    }
    // ③b 情绪数据还没补出来时，把心情词当关键词再试一轮（库里已经有人用「困」「无语」当 tag 了）
    for (const e of emos) {
      const hit = find(e);
      if (hit) return { ...hit, via: `mood-kw:${e}` };
    }
    // ④ 心情相关的都没情绪数据时，退而求其次挑一张「用得最少」的（别让 `[表情]` 空跑）
    // ⚠️ 变量名不能叫 `list`：本模块有个同名函数 `list()`，`const list = list(999)`
    //    会在声明语句里就进入 TDZ 并抛 ReferenceError，被下面的 catch 吞成 return null
    //    ——表现就是「[表情] 空参数永远挑不到」。这跟今天 `const raw` 遮蔽 import 是同一类坑，
    //    已用 `cand` 避开（2026-10-25）。
    try {
      const cand = list(999).filter((x) => (x.emotion ?? []).length || (x.tags ?? []).length);
      if (!cand.length) return null;
      cand.sort((a, b) => Number(a.hits ?? 0) - Number(b.hits ?? 0));
      const it = cand[0];
      const p = path.join(dir, it.file);
      if (!fs.existsSync(p)) return null;
      return { key: it.key, path: p, item: it, via: "least-used" };
    } catch {
      return null;
    }
  }

  // ---------- 发：按关键词找一张 ----------
  function score(it, kw) {
    const k = String(kw).normalize("NFKC").toLowerCase();
    if (!k) return 0;
    const tags = (it.tags ?? []).map((t) => String(t).toLowerCase());
    const desc = String(it.desc ?? "").toLowerCase();
    const file = String(it.file ?? "").toLowerCase();
    if (tags.includes(k)) return 100; // 标签全中
    if (desc === k) return 95;
    if (desc.includes(k)) return 80; // 描述包含
    if (tags.some((t) => t.includes(k) || k.includes(t))) return 60;
    if (file.includes(k)) return 30;
    return 0;
  }

  /**
   * @param {string} keyword 口语关键词，如「猫」「您有钳」
   * @returns {{key:string,path:string,item:object}|null}
   */
  function find(keyword) {
    try {
      const idx = load();
      let best = null;
      let bestScore = 0;
      for (const [key, it] of Object.entries(idx.items)) {
        if (it.status !== "active") continue;
        const p = path.join(dir, it.file);
        if (!fs.existsSync(p)) continue;
        const s = score(it, keyword);
        if (s <= 0) continue;
        // 同分优先用得少的（别老发同一张），再按新近
        if (
          s > bestScore ||
          (s === bestScore &&
            best &&
            (Number(it.hits) < Number(best.item.hits) ||
              (Number(it.hits) === Number(best.item.hits) && Number(it.addedAt) > Number(best.item.addedAt))))
        ) {
          best = { key, path: p, item: it };
          bestScore = s;
        }
      }
      return best;
    } catch (e) {
      log("表情查找失败:", e?.message ?? e);
      return null;
    }
  }

  // 发出一张之后记一笔（给「别老发同一张」用）
  function bumpHit(key) {
    try {
      const idx = load();
      if (idx.items[key]) {
        idx.items[key].hits = Number(idx.items[key].hits ?? 0) + 1;
        idx.items[key].lastUsed = Date.now();
        save(idx);
      }
    } catch (e) {
      log("表情记次失败:", e?.message ?? e);
    }
  }

  // ---------- 读图结果写回（2026-10-25 第二批）----------
  // 一张表情读完图之后，把「长什么样」和「适合什么情绪」一起写进索引。
  // 只补不覆盖：已经有 desc 的不会被空值冲掉（收藏那 22 张已经补好，别再动它们）。
  /**
   * @param {string} key
   * @param {{desc?:string, emotion?:string[], source?:string}} o
   * @returns {boolean} 有没有真的改到东西
   */
  function setDescribed(key, o = {}) {
    try {
      const idx = load();
      const it = idx.items?.[String(key)];
      if (!it) return false;
      let changed = false;
      const desc = String(o.desc ?? "").trim().slice(0, 60);
      // 原来的 desc 是空壳占位（"[动画表情]"）或空串时才写新的
      const descIsJunk = !it.desc || it.desc === "[动画表情]" || /^\[.*\]$/.test(it.desc);
      if (desc && descIsJunk) {
        it.desc = desc;
        // desc 一变就重算 tags（这次 desc 是有内容的，切词才有意义）
        const fresh = tagsFromText(desc);
        it.tags = [...new Set([...(it.tags ?? []).filter((t) => !/^(动画表情|动画|画表|表情)$/.test(t)), ...fresh])].slice(0, 30);
        changed = true;
      }
      const emo = Array.isArray(o.emotion) ? o.emotion.map((s) => String(s).normalize("NFKC").trim()).filter(Boolean).slice(0, 4) : [];
      if (emo.length) {
        it.emotion = [...new Set(emo)];
        it.emotionAt = Date.now();
        changed = true;
      }
      if (changed) {
        if (o.source) it.viewedBy = String(o.source).slice(0, 20);
        save(idx);
      }
      return changed;
    } catch (e) {
      log("写回描述失败:", e?.message ?? e);
      return false;
    }
  }

  /** 哪些还没描述过（空壳 desc 或没 emotion）——读图队列用它取活 */
  function needsDescribing(limit = 10) {
    try {
      return list(999)
        .filter((x) => {
          const descJunk = !x.desc || x.desc === "[动画表情]" || /^\[.*\]$/.test(x.desc);
          return descJunk || !(x.emotion ?? []).length;
        })
        // 2026-10-25 23:4x 改：**空壳优先**。
        // 原来只按 addedAt 老先补，结果「有 desc 只缺 emotion」的条目（都是早期手工补的）
        // 排在很前面，把每小时 5 张的配额全吃掉——实测 23:39 那一跳补的 5 张**全是缺 emotion 的老条目**，
        // 真空壳一张没动。现在：desc 是占位符的（真空壳）排第一档，只缺 emotion 的排第二档。
        .sort((a, b) => {
          const junk = (x) => (!x.desc || x.desc === "[动画表情]" || /^\[.*\]$/.test(x.desc) ? 0 : 1);
          const ja = junk(a);
          const jb = junk(b);
          if (ja !== jb) return ja - jb; // 0（空壳）排前面
          return Number(a.addedAt ?? 0) - Number(b.addedAt ?? 0); // 同档内老的先补
        })
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  // ---------- 统计 / 列出（给面板和自检用） ----------
  function stats() {
    const idx = load();
    const list = Object.entries(idx.items).map(([key, it]) => ({ key, ...it }));
    const active = list.filter((x) => x.status === "active");
    let bytes = 0;
    for (const it of active) {
      try {
        bytes += fs.statSync(path.join(dir, it.file)).size;
      } catch {
        /* 文件没了就跳过 */
      }
    }
    const byKind = {};
    for (const it of active) byKind[it.ext ?? "?"] = (byKind[it.ext ?? "?"] ?? 0) + 1;
    const bySource = {};
    for (const it of active) for (const s of it.sources ?? []) bySource[s] = (bySource[s] ?? 0) + 1;
    return { total: list.length, active: active.length, stale: list.length - active.length, bytes, byKind, bySource, dir };
  }

  function list(limit = 50) {
    const idx = load();
    return Object.entries(idx.items)
      .map(([key, it]) => ({ key, ...it }))
      .filter((x) => x.status === "active")
      .sort((a, b) => Number(b.addedAt ?? 0) - Number(a.addedAt ?? 0))
      .slice(0, limit);
  }

  // ---------- 给一张表情补标签（2026-10-25 实测逼出来的） ----------
  // 为什么必须有：QQ 收藏表情的 desc / ocrWord / modifyWord **实测全是空的**（22 条里 0 条有字）。
  // 所以光靠「desc 切词」这条路，`[表情:猫]` 在收藏夹那批上永远找不到——
  // 只能靠外部补：她发这张表情时说的那句话、或者主人自己给它起的名。
  /**
   * @param {string} key 表情 key
   * @param {string[]} tags 要补的标签（会去重）
   * @param {string} [desc] 顺手覆盖 desc（一般不用）
   */
  function addTags(key, tags, desc) {
    try {
      const idx = load();
      const it = idx.items[key];
      if (!it) return false;
      let n = 0;
      for (const t of tags ?? []) {
        const s = String(t).normalize("NFKC").trim().slice(0, 20);
        if (!s) continue;
        if (!it.tags.includes(s)) {
          it.tags.push(s);
          n++;
        }
      }
      if (desc && !it.desc) it.desc = String(desc).slice(0, 60);
      if (n) {
        it.tags = it.tags.slice(0, 40); // 上限，别让 tags 无限长
        save(idx);
      }
      return n > 0;
    } catch (e) {
      log("补标签失败:", e?.message ?? e);
      return false;
    }
  }

  // 按 key 取一条（补标签、面板展示用）
  function get(key) {
    try {
      const it = load().items?.[String(key)];
      if (!it) return null;
      const p = path.join(dir, it.file);
      return fs.existsSync(p) ? { key: String(key), path: p, item: it } : null;
    } catch {
      return null;
    }
  }

  // 刚收进来的那张是哪条（收图时拿到路径、但不知道 key，用这个反查）
  function keyByPath(absPath) {
    try {
      const base = path.basename(String(absPath ?? ""));
      if (!base) return null;
      const idx = load();
      for (const [key, it] of Object.entries(idx.items)) {
        if (it.file === base) return key;
      }
      return null;
    } catch {
      return null;
    }
  }

  // ---------- C 层：往收藏夹写之前先备份清单 ----------
  function backupFavoriteList(rows) {
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      const name = `fav-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
      const p = path.join(backupDir, name);
      fs.writeFileSync(p, JSON.stringify({ at: Date.now(), count: rows.length, rows }, null, 2), "utf8");
      return p;
    } catch (e) {
      log("收藏夹备份失败:", e?.message ?? e);
      return null;
    }
  }

  // 本机日期的 YYYY-MM-DD（2026-10-26 修：原来用 toISOString 是 UTC，所谓的「一天」
  // 早上 8 点就换了一轮，跟这台机器记日子的规矩对不上）
  function ymdToday() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  // 每天往收藏夹加了几张（硬上限用）
  function favUploadsToday() {
    const p = path.join(stateDir, "fav-upload.jsonl");
    const day = ymdToday();
    let n = 0;
    try {
      for (const line of fs.readFileSync(p, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line);
          if (String(o.day) === day && o.ok) n++;
        } catch {
          /* 坏行跳过 */
        }
      }
    } catch {
      /* 没有这个文件就是 0 */
    }
    return n;
  }

  function recordFavUpload(o) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      const line = JSON.stringify({ day: ymdToday(), at: Date.now(), ...o });
      fs.appendFileSync(path.join(stateDir, "fav-upload.jsonl"), line + "\n", "utf8");
    } catch (e) {
      log("收藏夹上传记账失败:", e?.message ?? e);
    }
  }

  return {
    dir,
    indexPath,
    load,
    save,
    ensureDir,
    absorb,
    find,
    // 情绪维度（2026-10-25 第二批）
    pick,
    findByEmotion,
    emotionsForMood,
    setDescribed,
    needsDescribing,
    bumpHit,
    stats,
    list,
    // 从已有 desc 本地推 emotion（2026-10-25 23:5x，主人拍板「不调模型、直接推」）
    inferEmotionFromDesc,
    addTags,
    get,
    keyByPath,
    backupFavoriteList,
    favUploadsToday,
    recordFavUpload,
    tagsFromText,
  };
}
