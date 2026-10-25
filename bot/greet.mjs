// 观澜 · 问候域（2026-10-25 解耦）
// ---------------------------------------------------------------------------
// 管三样：**三档问候的记账**（今天发过没）、**待补的那一档**、**她自己做事的日期**。
// 字段：greet, pendingGreet, planDay, nightDay, ownDay, lastOwnAt
//
// **分法说明**：这一域只搬「状态 + 纯判定」。
// `maybeTimeGreeting()` 那个执行体**留在 whale-bot.mjs**——因为它要调
// `greetPrompt` / `runQueuedTask` / `anniversariesToday` / `replyToOwnerAndArchive`
// 一大串外部函数，搬过来只会把依赖表搞得更长、把 greet.mjs 变成第二个主文件。
// 所以这里只提供「现在该不该发、该发哪一档」的判断（`greetPlan`），
// 以及「发完了记账」的写入口。执行留在原处，读的仍然是这里的判定函数。
//
// **跨域读**：要知道他忙不忙、睡没睡（`isQuiet`）。走注入，不 import life.mjs。
import { get, raw, writeState } from "./state.mjs";

// —— 问候窗口（照搬原实现，勿改）——
export const GREET_WINDOWS = {
  morning: [8, 0, 10, 0],
  noon: [11, 30, 13, 0],
  night: [21, 30, 23, 0],
};
export const GREET_KEYS = ["morning", "noon", "night"];
// 本该发却撞上忙/睡/谷时的，窗口关了还能再等这么久补一句
export const GREET_GRACE_MIN = 45;

let readQuiet = () => false;

export function initGreet({ isQuiet } = {}) {
  if (typeof isQuiet === "function") readQuiet = isQuiet;
}

/** 北京时间三元组（本模块自带，不依赖 whale-bot 的 bjParts）。 */
function bjParts(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600e3);
  return {
    day: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday: d.getUTCDay(),
  };
}

export function inWindow(win, hour, minute, graceMin = 0) {
  const cur = hour * 60 + minute;
  return cur >= win[0] * 60 + win[1] && cur < win[2] * 60 + win[3] + graceMin;
}

export function isSunday(day) {
  return new Date(`${day}T12:00:00+08:00`).getDay() === 0;
}

/**
 * 谷时：工作日 9-12、14-18 不主动开口。
 * **早安例外**——早上 8-10 与谷时重叠，不放宽的话工作日基本发不出去、也补不了。
 */
export function isPeakHour(ts = Date.now()) {
  const { hour, minute, weekday } = bjParts(ts);
  if (weekday === 0 || weekday === 6) return false;
  const h = hour + minute / 60;
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

/**
 * 纯判断：某个时刻该不该发问候、是不是补发（不发、不写盘，方便预演核对）。
 * **别在这里调模型或发消息**——它是给 `maybeTimeGreeting()` 做决定的。
 */
export function greetPlan(now = Date.now()) {
  const { day, hour, minute } = bjParts(now);
  const active = GREET_KEYS.find((k) => inWindow(GREET_WINDOWS[k], hour, minute));
  const grace = GREET_KEYS.find((k) => inWindow(GREET_WINDOWS[k], hour, minute, GREET_GRACE_MIN));
  const quiet = readQuiet(); // 忙 / 睡了
  const blocking = active ?? grace;
  const pending = get("pendingGreet", null);
  const pendingKind =
    pending?.day === day &&
    inWindow(GREET_WINDOWS[pending.kind], hour, minute, GREET_GRACE_MIN)
      ? pending.kind
      : null;
  const kind = active ?? pendingKind;
  // 谷时规矩：工作日 9-12、14-18 不主动开口；但「早安」例外
  const peak = isPeakHour(now) && (kind ?? blocking) !== "morning";
  return {
    day,
    hour,
    minute,
    active,
    grace,
    blocking,
    quiet,
    peak,
    pendingKind,
    kind,
    late: Boolean(kind) && !active,
  };
}

// —— 读 ——
export const greetSent = () => ({ ...(get("greet", {}) || {}) });
export const pendingGreet = () => get("pendingGreet", null);
export const planDay = () => get("planDay", null);
export const nightDay = () => get("nightDay", null);
export const ownDay = () => get("ownDay", null);
export const lastOwnAt = () => Number(get("lastOwnAt", 0)) || 0;

// —— 写 ——
/** 记下「这一档今天发过了」+ 顺带记她写日程/复盘的日期。 */
export function markGreetSent(kind, day) {
  const s = raw();
  s.greet ??= {};
  s.greet[kind] = day;
  if (s.pendingGreet?.kind === kind) s.pendingGreet = null;
  if (kind === "morning") s.planDay = day;
  if (kind === "night") s.nightDay = day;
  writeState();
}

/** 压着那一档：撞忙/睡/谷时先记下，宽限期内还能补。 */
export function setPendingGreet(kind, day) {
  const s = raw();
  s.pendingGreet = { kind, day };
  writeState();
}

export function clearPendingGreet() {
  const s = raw();
  if (s.pendingGreet) {
    s.pendingGreet = null;
    writeState();
  }
}

/** 记「今天已经找过事了」。 */
export function markOwnDone(day, now = Date.now()) {
  const s = raw();
  s.ownDay = day;
  s.lastOwnAt = now;
  writeState();
}
