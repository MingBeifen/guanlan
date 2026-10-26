// 观澜 · 心情域（2026-10-25 解耦）
// ---------------------------------------------------------------------------
// 管三样：**心情值 mood（0-100）**、**氛围偏移 alterScore**、以及由它们派生的话术。
// 字段：mood, moodAt, alterScore, alterAt, alterNote, alterNoteSign
//
// **跨域读**：`moodDecay` 要知道「他忙不忙」来决定心情下限（忙时停 50、平时停 25），
// `urgeRhythm` 要读忙睡来算生活节奏。这两处都是**只读**，通过注入的 `readBusy()`
// 拿值——**不要让 mood 模块反过来 import life 模块**，否则会形成循环依赖
// （life 域的 `setAsleep` 里也要改 moodAt，是反向的读）。
//
// 为什么心情和氛围放一起：它们是同一类东西（她的当前情绪底色），
// 而且 `alterAccumulate` 的阈值判定要和 mood 一起看才有意义。
import { get, raw, writeState } from "./state.mjs";

/** 日志（由 whale-bot 注入，保持本模块不依赖主文件）。 */
let logger = () => {};
/** 只读访问忙睡域（注入，避免循环 import）。 */
let readBusy = () => false;
let readAsleep = () => false;

export function initMood({ log, isBusy, isAsleep } = {}) {
  if (typeof log === "function") logger = log;
  if (typeof isBusy === "function") readBusy = isBusy;
  if (typeof isAsleep === "function") readAsleep = isAsleep;
}

// —— 读 ——
export const moodOf = () => Number(get("mood", 62));
export const moodAt = () => Number(get("moodAt", 0));
export const alterScore = () => Number(get("alterScore", 0));

/** 心情 → 一句人话（styleParts 用）。 */
// ⚠️ 2026-10-26 大改（主人拍板「三条全做」）：从 5 档拆成 9 档 + 换掉「有点闷」。
//
// **为什么要改**：原来 30-44 这 15 分宽的一档叫「有点闷」，而 `whale-bot.mjs` 每轮私聊
// 都往提示词里推一句「你此刻的心情：有点闷（43/100）」。她 25 条含「闷」的回复里
// **10 条是原样复述这个档位名**——她不是想说，是没别的词可说，系统只给了这一个。
// 更糟的是档位 15 分宽、一次被夸只 +3 → 安慰永远推不过边界，标签卡一整天，
// 于是每轮提示词还在说同一句话，她就每轮再复述一遍（19:33 的 43 秒内说了两遍）。
//
// **三条一起改**：① 档位 15 分 → 约 11 分一档（9 档），让一次正向反馈能跨过去；
// ② 「有点闷」这个词**从词表里删掉**，换成「有点提不起劲 / 不太有劲」这类描述状态而非
//    命名情绪的词——命名情绪的词最容易被当成自我描述照抄；
// ③ `moodMove` 被夸 +3 → +6（见下方），一次真心夸奖就能推动档位。
//
// **必须保住的边界**：`alterLine()` 用 `moodOf() < 45` 判「低心情不推她活泼」，
// 所以 **45 必须仍然是某一档的下界**（这里是「还行」）。改档位时别把这个数动掉。
export function moodLabel(m = moodOf()) {
  if (m >= 88) return "状态很好";
  if (m >= 76) return "挺有精神";
  if (m >= 64) return "还算松快";
  if (m >= 54) return "平常";
  if (m >= 45) return "还行";
  if (m >= 36) return "有点提不起劲";
  if (m >= 26) return "不太有劲";
  if (m >= 15) return "低落";
  return "很丧";
}

// —— 写 ——
/** 心情加减（被夸 +6 / 被骂 -7 / 做成事 +2 等）。**唯一的心情修改入口。** */
export function moodMove(d, why = "") {
  const s = raw();
  const before = Number(s.mood ?? 62);
  s.mood = Math.max(0, Math.min(100, Math.round(before + d)));
  s.moodAt = Date.now();
  if (before !== s.mood) logger(`心情 ${before} -> ${s.mood}（${why}）`);
  writeState();
  return s.mood;
}

/** 只刷新「上次动心情的时刻」不加减分（他被叫醒/闲下来时用）。 */
export function touchMoodAt() {
  raw().moodAt = Date.now();
  writeState();
}

/** 没人搭理就慢慢回落：低到 25 就停住，忙的时候停在 50。 */
export function moodDecay() {
  const s = raw();
  const now = Date.now();
  const hrs = (now - (s.moodAt ?? now)) / 3600000;
  if (hrs < 1) return;
  const floor = readBusy() ? 50 : 25;
  const drop = Math.min(14, Math.round(hrs * 2));
  const next = Math.max(floor, Math.round((s.mood ?? 62) - drop));
  if (next !== s.mood) logger(`心情自然回落：${s.mood} -> ${next}（${hrs.toFixed(1)} 小时没动静）`);
  s.mood = next;
  s.moodAt = now;
  writeState();
}

// —— 氛围偏移（Alter）——
// 她在回复末尾写隐藏标记 [氛围:+n]，这里累积成 alterScore。
// 越过阈值就注入一句「当前氛围」描述；不越过就只是记账。
const ALTER_INJECT_THRESHOLD = 8;

// 氛围分的上下限（2026-10-25 主人拍板加的）。
// 为什么必须夹：这个分是**她自己**在回复末尾写 `[氛围:-n]` 累积出来的，没有上限时形成正反馈——
// 越丧越写负分，负分越过阈值 8 就每轮被注入一句「当前氛围…」。实测那天累到 **-46.58**，
// 等于每句话前头都被按一句「今天很糟」，她自己也一直在说「提不起劲」。
// 夹到 ±20 之后：仍然是「有点偏」（超过阈值 8 还能感知），但不会越积越深到底。
const ALTER_MIN = -20;
const ALTER_MAX = 20;

// ===========================================================================
// 氛围分的「向 0 回归」（2026-10-26 主人选的 A：只做日间回落，不做每日清零）
// ===========================================================================
// **修的是什么**：`alterScore` 原来只有「累加 + 夹边界」，**没有任何回落**。
// 实测 2026-10-26 15:13 它卡在 **-20（下界）**，而且日志里一路都是
//   `氛围分撞边界：-20 + -1 = -21 → 夹到 -20`（10-25 21:03 到 10-26 07:12 连续十几次）。
// 后果不只是"数字难看"：`alterLine()` 在 |a| >= 8 时**每轮都注入**
//   「今天的氛围松了，可以稍微活泛一点（累积 -20）」→ 她读到这句就更倾向写 `[氛围:-1]`
//   → 继续撞边界 → **正反馈死锁**，永远出不来。
//
// **两个必须避开的坑（写之前就核实过）**：
//  ① **不能照抄 `moodDecay` 的方向**：mood 是 0-100 的"高低"，回落就是单调往下；
//     而 `alterScore` 是 **-20~+20 的偏移量**，回落必须**朝 0 走**（正负都向中性靠）。
//     方向搞反会从"永远 -20"变成"永远负"，等于没修。
//  ② **不能挂在 `maybeTimeGreeting()` 里**（那是 `moodDecay()` 现在的挂载点）：
//     那个函数开头有 `if (pauseMode() !== "off") return;`，**一暂停连回落都停了**，
//     会重现"暂停一天就永久锁死"。所以这条挂在**独立的 minutes 级巡检**（见 whale-bot 的
//     `setInterval(guarded("氛围回归", alterDecay), CFG.housekeepingTickMs)`），不受暂停影响。
//
// **速率**：每小时向 0 靠近 **1 步**（`ALTER_DECAY_PER_HOUR`）。
//   · 从 -20 回到 0 需要 20 小时 —— 慢，但语义正确：她要"真的聊得轻松起来"才该爬回来，
//     不是被系统一键洗白。
//   · 距离 0 越近，步长不变（不是比例回归）——简单、可解释、面板上看得懂。
//   · 只动**整数步**，不产生小数；已经在 0 就直接返回，不写盘（省掉每分钟一次无谓 IO）。
const ALTER_DECAY_PER_HOUR = 1;

/**
 * 按「距上次变动过了多久」把 alterScore 往 0 拉。纯时间驱动，可被任意巡检调用。
 * 返回拉完后的值。**幂等**：时间没走够就原样返回、不写盘。
 */
export function alterDecay(now = Date.now()) {
  const s = raw();
  const cur = Number(s.alterScore ?? 0);
  if (!cur) return 0; // 已经是 0，没事可做
  const last = Number(s.alterAt ?? 0);
  if (!last) {
    // 没有 alterAt（老数据/从没动过）→ 记一次时间戳，从下一轮开始算，避免一上来就跳
    s.alterAt = now;
    writeState();
    return cur;
  }
  const hrs = (now - last) / 3600000;
  // 每满 1 小时走 1 步；最多一次走完这段积压（长时间没跑也别一步跳回 0 之外）
  const steps = Math.floor(hrs * ALTER_DECAY_PER_HOUR);
  if (steps <= 0) return cur;
  // 朝 0 走：正数减、负数加；不越过 0（`Math.sign` 保证方向）
  const next = Math.abs(cur) <= steps ? 0 : cur - Math.sign(cur) * steps;
  if (next === cur) return cur;
  s.alterScore = next;
  s.alterAt = now;
  s.alterNoteSign = Math.sign(next) || 0;
  writeState();
  logger(
    `氛围分回归：${cur} -> ${next}（${hrs.toFixed(1)} 小时没变动，每 ${(1 / ALTER_DECAY_PER_HOUR).toFixed(0)} 小时向 0 走 1）`,
  );
  return next;
}

/** 累积一次氛围分。返回累积后的值（调用方要判断是否越阈值）。 */
export function alterAccumulate(n) {
  const s = raw();
  const before = Number(s.alterScore ?? 0);
  const delta = Number(n) || 0;
  // 夹在 ±ALTER 之内：**这是硬护栏**，别改成「只夹不报」——日志要能看出撞过边界
  // ⚠️ 变量名别叫 `raw`：本文件顶部 `import { get, raw, writeState }` 里的 `raw` 是
  //    state.mjs 的读取函数，同名 const 会在函数作用域里把它遮蔽 → 整个函数 TDZ
  //    报 `Cannot access 'raw' before initialization`，而且是在**发送消息那一步**炸，
  //    表现为「控制台看得到她说话、QQ 一条都收不到」（2026-10-25 踩过一次，已改此名）。
  const sum = before + delta;
  const next = Math.max(ALTER_MIN, Math.min(ALTER_MAX, sum));
  s.alterScore = next;
  s.alterAt = Date.now();
  // 同号继续累加、异号减弱；符号记在 alterNoteSign 里给面板显示
  s.alterNoteSign = Math.sign(s.alterScore) || 0;
  writeState();
  if (next !== sum) logger(`氛围分撞边界：${before} + ${delta} = ${sum} → 夹到 ${next}（范围 ${ALTER_MIN}~${ALTER_MAX}）`);
  return s.alterScore;
}

/** 越过阈值时要注入的那一行；没越过返回空串。 */
export function alterLine() {
  const a = alterScore();
  if (Math.abs(a) < ALTER_INJECT_THRESHOLD) return "";
  // ⚠️ 2026-10-26 修（主人点头做的，Q2「低心情时不注入」）：
  // 原来 a<0 一律注入「今天的氛围松了，**可以稍微活泛一点**」。实测后果——
  // 她心情 33（有点闷）、话已经很少、只想窝着的时候，这句话**每轮都在推她活泼**，
  // 而同一份提示词里 `moodLabel()` 那条写的是「心情低就话少一点、别撒娇别闹」。
  // **两条提示词直接打架**，而且打了好几轮都没人发现（它不报错、只是让她说话更别扭）。
  //
  // 现在的口径：**心情低的时候，氛围那条只描述、不推动**。
  //   · mood < 45（「有点闷」及以下）→ 用中性描述，去掉「可以稍微活泛一点」这个祈使句；
  //   · 心情正常 → 保留原句（那是她真的活泛起来的场合）。
  // 判据为什么取 45：`moodLabel()` 的档位是 78/60/45/30/15，45 正好是「还行」的下界，
  // 低于它就是「有点闷 / 低落 / 很丧」三档——那三档里推她活泼都是反着来的。
  const lowMood = moodOf() < 45;
  const expr =
    a >= 0
      ? "今天的氛围偏正式、绷得紧一些，说话别太闹"
      : lowMood
        ? "今天这几轮聊得比较松（只是描述，别勉强自己活泼）"
        : "今天的氛围松了，可以稍微活泛一点";
  const note = String(get("alterNote", "") ?? "").trim();
  return `[当前氛围：${expr}${note ? `（${note}）` : ""}（累积 ${a > 0 ? "+" : ""}${a}）]`;
}

/** 被她或主人重置氛围（一般不用）。 */
export function alterReset() {
  const s = raw();
  s.alterScore = 0;
  s.alterAt = Date.now();
  s.alterNote = "";
  s.alterNoteSign = 0;
  writeState();
  return 0;
}
