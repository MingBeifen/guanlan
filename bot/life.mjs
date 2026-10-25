// 观澜 · 忙睡域（2026-10-25 解耦）
// ---------------------------------------------------------------------------
// 管两件事：**主人忙不忙**、**主人睡没睡**。
// 字段：busy, busySince, busyNote, asleep, sleepSince, sleepNote, sleepKind
//
// 这是**四个域里最关键的**——`isQuiet()` 是全局总闸，所有主动行为都看它：
//   isQuiet() = isBusy() || isAsleep()   ← **只挡主动，不挡回复**
//
// **跨域**：醒来/闲下来要刷一下心情的 `moodAt`，醒来还要 `moodMove(+4)`。
// 这两处都是**写另一个域**，所以必须走注入进来的心情域函数，
// 而不是让 life 模块直接改 mood 字段——否则两个模块对同一字段都有写权，拆分就白做了。
//
// ⚠️ 本文件里的判定词表（SLEEP_RE / WAKE_RE / SLEEP_NOT_GOING_RE）**逐字照搬原实现**，
// 一个字符都没改——它们是「哪句话算去睡、哪句话算醒来」的唯一口径，
// 改一个字都可能让他半夜说「我睡不着」被判成去睡了（2026-10-22 真踩过）。
import { get, raw, writeState } from "./state.mjs";

let logger = () => {};
/** 心情域的写入口（注入，避免循环 import）。 */
let onRelaxed = () => {};
let onWoke = () => {};

export function initLife({ log, touchMoodAt, moodMove } = {}) {
  if (typeof log === "function") logger = log;
  if (typeof touchMoodAt === "function") onRelaxed = touchMoodAt;
  if (typeof moodMove === "function") onWoke = moodMove;
}

// —— 判词（照搬原实现，勿改）——
// 10 点到 17 点之间说去睡算「午睡」，只认他亲口说醒、不按时间自动算醒；
// 别的钟点算「过夜」，说醒 / 隔 20 分钟又开口就算醒。
const SLEEP_RE =
  /^(那我|那|我|好|行|嗯|哦|嗯嗯)?[，,。！!~ ]*(先|这就|要|该|去|准备|马上|洗洗|躺)?(去)?(睡|歇了|眯|躺会儿)|^晚安|^好梦|^(好|好嘛|那)?(我)?(好)?困|我(先|要|这就|准备)?(去)?睡(了|啦|觉|觉了)/;
const WAKE_RE =
  /^(那|我|嗯|哦|好|行)?[，,。！!~ ]*(刚|终于|可算|总算)?(睡|躺)?(醒|起床|起来|不睡|回来|回啦)|^早(安|上好|啊|呀)?[，,。！!~ ]*$/;
// 说「睡不着 / 失眠 / 还没睡」不是要去睡，先挡一道
const SLEEP_NOT_GOING_RE =
  /睡不着|睡不好|睡不下|睡不踏实|失眠|还没睡|没睡呢|不困|睡够了|睡了吗|睡了没|睡了么/;
// 说「睡了」之后这 20 分钟里的零碎话（「嗯」「晚安」）还算睡前絮叨，不当醒来
const SLEEP_GRACE_MS = 20 * 60 * 1000;
// 午睡钟点段：10:00 到 16:59 之间说去睡都算小睡，其余算过夜
const NAP_FROM_HOUR = 10;
const NAP_TO_HOUR = 17;

/** 北京时间的小时（本模块自带，不依赖 whale-bot 的 bjParts）。 */
function bjHour(ts = Date.now()) {
  return new Date(ts + 8 * 3600e3).getUTCHours();
}

/** 这会儿是不是「该算午睡」的钟点段（10:00-16:59）。 */
export function napNow(ts = Date.now()) {
  const hour = bjHour(ts);
  return hour >= NAP_FROM_HOUR && hour < NAP_TO_HOUR;
}

// —— 读 ——
export const isBusy = () => Boolean(get("busy", false));
export const isAsleep = () => Boolean(get("asleep", false));
export const busyNote = () => String(get("busyNote", "") ?? "");
export const sleepNote = () => String(get("sleepNote", "") ?? "");
export const sleepSince = () => Number(get("sleepSince", 0)) || 0;
export { SLEEP_RE, WAKE_RE, SLEEP_NOT_GOING_RE };

/** 「这会儿是午睡吗」——午睡不按时长自动醒，等他亲口说醒。 */
export function isNap() {
  return Boolean(get("asleep", false)) && String(get("sleepKind", "")) === "nap";
}

/**
 * **全局总闸**：忙或睡时她都不主动开口。
 * ⚠️ 只挡主动（问候/搭话/找事），**不挡回复**——他说话她照常答。
 */
export function isQuiet() {
  return isBusy() || isAsleep();
}

// —— 写 ——
/** 他忙/不忙。**唯一入口。** */
export function setBusy(on, note = "") {
  const s = raw();
  s.busy = Boolean(on);
  s.busySince = on ? Date.now() : null;
  s.busyNote = on ? String(note).slice(0, 60) : "";
  writeState();
  // 闲下来了：心情该重新起算（原来这行直接写 pro.moodAt，拆走后改成调心情域）
  if (!on) onRelaxed();
}

/** 他睡/醒。不传 kind 时按钟点自动判 nap/night（与原实现一致）。 */
export function setAsleep(on, note = "", kind = "") {
  const s = raw();
  s.asleep = Boolean(on);
  s.sleepSince = on ? Date.now() : null;
  s.sleepNote = on ? String(note).slice(0, 60) : "";
  s.sleepKind = on ? String(kind || (napNow() ? "nap" : "night")) : "";
  writeState();
  if (!on) onRelaxed();
}

/**
 * 「他开口了」= 醒着的证据。**逐字照搬原实现的三道判定**：
 *   ① 不是在说要去睡（`SLEEP_RE` 命中且不是「睡不着」那类）
 *   ② 要么说了醒来的话（`WAKE_RE`）、要么是过夜且已过 20 分钟宽限
 *   ③ 午睡不按时间自动醒，只认他亲口说醒
 * @returns {boolean} 这次有没有真的解除睡眠
 */
export function noteOwnerAwakeFromChat(t) {
  const s = raw();
  if (!s.asleep) return false;
  const text = String(t || "").trim();
  if (!text) return false;
  if (SLEEP_RE.test(text) && !SLEEP_NOT_GOING_RE.test(text)) return false;
  const canAutoWake = !isNap();
  const longEnough = Date.now() - (s.sleepSince ?? 0) > SLEEP_GRACE_MS;
  if (!(WAKE_RE.test(text) || (canAutoWake && longEnough))) return false;
  const wasNap = isNap();
  setAsleep(false);
  onWoke(4, "主人醒了");
  logger(
    `主人在群里开口了：${wasNap ? "午睡" : "过夜"}结束，睡眠状态解除，主动消息恢复`,
  );
  return true;
}
