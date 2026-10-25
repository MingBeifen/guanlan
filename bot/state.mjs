// 观澜的「当前状态」骨架（2026-10-25 解耦第一步）
// ---------------------------------------------------------------------------
// 为什么要这个文件：原来 `pro` 是 whale-bot.mjs 里的一个模块级可变对象，
// 101 处引用分布在各处，任何函数都能直接改她当前的状态，没有单一修改入口。
// 拆成四个域（心情 / 忙睡 / 问候 / 群沉默）之后，每个域有自己的读写函数，
// **状态的所有权变清楚了**——改心情只需要看 mood 域，不用翻整个 10400 行。
//
// ⚠️ 三条硬约束（拆分前定下的，不得违反）：
//   ① **字段名一律不改**——`panel/server.mjs` 的 `sleepState()` 直接读
//      `home/state/proactive.json` 的 17 个字段名，改名会让面板读到 `undefined`
//      （不报错，界面上只显示「-」，属于典型静默失效）。
//   ② **拆模块不拆文件**——仍然只写 `home/state/proactive.json` 一个文件，
//      共享同一个 `writeState()`。拆成四个 json 会让「一次原子写」变成「四次写」，
//      中间崩了就一半新一半旧。
//   ③ **兜底集中在加载处一处**——`??=` 与清历史键都在本文件的 `load()` 里，
//      不散到四个域模块，否则某处忘了兜底会让残留旧键变 undefined 参与计算。
//
// 四域字段归属（改代码时照这张表找）：
//   mood : mood, moodAt, alterScore, alterAt, alterNote, alterNoteSign
//   life : busy, busySince, busyNote, asleep, sleepSince, sleepNote, sleepKind
//   greet: greet, pendingGreet, planDay, nightDay, ownDay, lastOwnAt, ownNote
//   mute : groupMute
import fs from "node:fs";
import path from "node:path";

let STATE_PATH = "";
let state = {};
let logger = () => {};

/** 默认值（每个域的初始值都在这里，四个域模块不再各自写一份）。 */
export function freshState() {
  return {
    // —— 忙睡域 ——
    busy: false,
    busySince: null,
    busyNote: "",
    asleep: false,
    sleepSince: null,
    sleepNote: "",
    sleepKind: "", // "nap" 午睡 / "night" 过夜：醒了的口径不一样
    // —— 心情域 ——
    mood: 62,
    moodAt: Date.now(),
    // —— 问候域 ——
    greet: {},
    pendingGreet: null, // { kind, day }：本该发却撞上忙/睡/谷时的问候，宽限期内补
    planDay: null,
    nightDay: null,
    ownDay: null,
    lastOwnAt: 0,
    // —— 群沉默域 ——
    // {"群号":{"until":ms,"at":ms,"note":""}}
    // 只挂「群里的主动与接话」，@ 她 / QQ 回复她 / 戳一戳照常答。
    groupMute: {},
  };
}

/**
 * 初始化。**必须在任何读写之前调一次**。
 * @param {string} statePath proactive.json 的绝对路径（由 whale-bot 注入，本模块不猜路径）
 * @param {function} log 写日志的函数（注入进来，本模块自己不引 whale-bot）
 */
export function initState(statePath, log) {
  STATE_PATH = statePath;
  if (typeof log === "function") logger = log;
  const raw = (() => {
    try {
      return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) || {};
    } catch {
      return {};
    }
  })();
  state = { ...freshState(), ...raw };

  // —— 兜底集中在这里（硬约束③）——
  state.greet ??= {};
  state.asleep ??= false;
  state.sleepKind ??= "";
  state.pendingGreet ??= null;
  state.groupMute ??= {};

  // 2026-10-22：引用原文里的「我要睡了」被当成他说睡留下的假状态，读进来就作废
  if (state.asleep && /^\[引用的是这条：/.test(state.sleepNote ?? "")) {
    state.asleep = false;
    state.sleepSince = null;
    state.sleepNote = "";
    state.sleepKind = "";
  }

  // 2026-10-22 那套「她自己睡」整块拆掉了，带过来的旧键顺手清掉，
  // 别留在盘上、也别让面板翻出来迷惑人
  for (const k of [
    "herAsleep",
    "herDrowsy",
    "herDrowsyAt",
    "herDrowsyTold",
    "heSaidNightAt",
    "herSleepAt",
    "herWakeAt",
    "herWokenAt",
    "herBedHour",
    "herSleepDay",
    "herWakeDay",
    "herWakePendingDay",
    "herWakePendingAt",
    "herSleepNote",
  ]) {
    delete state[k];
  }
  return state;
}

/** 整个状态对象（只读用途：面板数据、调试。**改它请走各域的 setter**）。 */
export function getState() {
  return state;
}

/** 落盘。所有域共用这一个（硬约束②）。 */
export function writeState() {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
    return true;
  } catch (e) {
    logger(`主动生活状态没存上: ${e?.message ?? e}`);
    return false;
  }
}

/**
 * 只读一个字段（跨域读专用）。
 * 设计意图：心情域要读「忙不忙」、问候域要读「心情几分」——这类**只读**跨域，
 * 用 getter 而不是让模块互相 import，避免循环依赖。
 */
export function get(key, fallback = undefined) {
  return state[key] === undefined ? fallback : state[key];
}

/** 写注：仅供各域模块内部的 setter 使用，业务代码不要直接调。 */
export function raw() {
  return state;
}
