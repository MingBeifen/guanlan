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
export function moodLabel(m = moodOf()) {
  if (m >= 78) return "心情很好";
  if (m >= 60) return "心情不错";
  if (m >= 45) return "还行";
  if (m >= 30) return "有点闷";
  if (m >= 15) return "低落";
  return "很丧";
}

// —— 写 ——
/** 心情加减（被夸 +3 / 被骂 -7 / 做成事 +2 等）。**唯一的心情修改入口。** */
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
  const expr =
    a >= 0 ? "今天的氛围偏正式、绷得紧一些，说话别太闹" : "今天的氛围松了，可以稍微活泛一点";
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
