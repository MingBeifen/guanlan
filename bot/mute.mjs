// 观澜 · 群内沉默域（2026-10-25 解耦）
// ---------------------------------------------------------------------------
// 管：**哪些群现在让她闭嘴**。字段：groupMute
//   { "群号": { until: ms, at: ms, note: "" } }
//
// 语义（和另三种静音严格区分）：
//   - 只挡**群里的主动与接话**；
//   - **主人 @ 她 / QQ 回复她某条 / 戳一戳，照常应答**；
//   - 私聊、主动问候、日记完全不受影响；
//   - 群里说的话**照样收进上下文**（解禁后不会「中间这段没听见」）；
//   - 默认 2 小时自动过期。
//
// 与 `pause.json` 的 `group-mute` 的区别：那个只判 `message_type === "group"`，
// **连主人 @ 一起挡**，是硬静音。两者不要混用。
import { get, raw, writeState } from "./state.mjs";

let logger = () => {};

export function initMute({ log } = {}) {
  if (typeof log === "function") logger = log;
}

export const GROUP_MUTE_DEFAULT_MS = 2 * 60 * 60 * 1000; // 2 小时

/**
 * 这个群现在是不是处于沉默。
 * **读的时候顺手清过期项**——省一个定时器，也保证面板读到的都是有效的。
 */
export function groupMuted(gid) {
  const id = String(Number(gid) || 0);
  const map = get("groupMute", {}) || {};
  const slot = map[id];
  if (!slot) return false;
  const until = Number(slot.until) || 0;
  if (until && Date.now() >= until) {
    delete map[id];
    writeState();
    logger(`群 ${id} 的沉默标签到点了，自动解除`);
    return false;
  }
  return true;
}

/** 当前所有还在沉默的群（面板/自检要看）。 */
export function groupMuteList() {
  const out = [];
  const map = get("groupMute", {}) || {};
  for (const gid of Object.keys(map)) {
    if (groupMuted(gid)) {
      const s = map[gid] || {};
      out.push({
        group: Number(gid),
        until: Number(s.until) || 0,
        at: Number(s.at) || 0,
        note: String(s.note || ""),
      });
    }
  }
  return out;
}

/** 开/关某个群的沉默。on=true 时默认 2 小时过期。 */
export function setGroupMute(gid, on, { note = "", ttlMs = GROUP_MUTE_DEFAULT_MS } = {}) {
  const id = String(Number(gid) || 0);
  const s = raw();
  s.groupMute ??= {};
  if (on) {
    const ms = Number(ttlMs) > 0 ? Number(ttlMs) : GROUP_MUTE_DEFAULT_MS;
    s.groupMute[id] = {
      until: Date.now() + ms,
      at: Date.now(),
      note: String(note || "").slice(0, 60),
    };
    logger(`群 ${id} 沉默标签打开（${Math.round(ms / 60000)} 分钟后自动解除）`);
  } else {
    delete s.groupMute[id];
    logger(`群 ${id} 沉默标签解除`);
  }
  writeState();
}

// —— 口令词表（照搬原实现，改词表只改这里）——
// 词尾的「吧 / 了 / 啊」这类语气词允许多挂一个（实测：「你闭嘴吧」原来认不出来，
// 因为词表里只有「你闭嘴」而后面跟了「吧」）。
// ⚠️ 尾巴只能由语气词/标点/空白组成，**不能吞掉任意字**——
// 实测「闭嘴是什么意思」曾被误判成口令，必须要求核心词之后再没有实义词。
const MUTE_CMD_TAIL = "(?:[吧了啊呀哦嘛呗呢~～。.、,，!！?？\\s])*$";
const MUTE_ON_RE = new RegExp(
  "^(?:你)?" +
    "(?:" +
    "(?:先|赶紧)?(?:给我)?(?:闭嘴|安静(?:点|点儿|会儿)?|别(?:再)?说话|别出声|消停(?:会)?儿?)" +
    "|(?:群里|在群里)(?:先|暂时)?(?:别|不要)(?:说话|出声)" +
    "|(?:你|你群里)?别再(?:说话|出声)" +
    ")" +
    MUTE_CMD_TAIL,
);
const MUTE_OFF_RE = new RegExp(
  "^(?:(?:现在|好了|行)[,，、\\s]*)?" +
    "(?:(?:可以|能)(?:说话|开口)(?:了)?" +
    "|(?:解除|取消)(?:沉默|禁言)" +
    "|解禁" +
    "|(?:你)?(?:说话|开口)吧)" +
    MUTE_CMD_TAIL,
);

/**
 * **私聊**口令：整条消息就得是这句话，中间夹带别的话不算（防误触，与 reboot 一致）。
 * 可选带群号（`群里别说话 1000000003`）。返回 { on, group } 或 null。
 */
export function parseGroupMuteCmd(rawText) {
  const t = String(rawText ?? "").trim();
  if (!t || t.length > 40) return null; // 一长串话里带个「闭嘴」多半在聊别的
  let group = 0;
  let body = t;
  const m = t.match(/(\d{5,12})[。.!！\s]*$/);
  if (m) {
    group = Number(m[1]);
    body = t.slice(0, m.index).trim();
  }
  if (MUTE_ON_RE.test(body)) return { on: true, group };
  if (MUTE_OFF_RE.test(body)) return { on: false, group };
  return null;
}

// 群里的沉默口令（用户原话：「我在群里让你别说话也能触发静默（在这个群），
// 只要带让你闭嘴或者让你别说话的这些词也算触发」）。
// 所以群里走**包含**判定，不要求整条正好是口令；但留三条刹车，免得把聊天当命令：
//   ① 只有主人本人说才算（别人在群里喊我闭嘴一律不理）——这条在调用方判；
//   ② 太长的不算（超 40 字，多半在讲一件事而不是下命令）；
//   ③ 在聊这个功能本身的不算，以及转述别人说过的话不算。
const GROUP_MUTE_HINT_RE =
  /(闭嘴|别(?:再)?说话|不要说话|不许说话|别出声|别吭声|别在群里说话|群里别说话|安静(?:点|点儿|会儿)|消停(?:会)?儿?)/;

/** **群里**的宽松口令。返回 { on } 或 null。解除仍只认整条（MUTE_OFF_RE）。 */
export function parseGroupMuteHint(rawText) {
  const t = String(rawText ?? "").trim();
  if (!t || t.length > 40) return null;
  // 在问这个功能、或者拿它做测试的句子：那是聊天，不是口令
  // （「能不能」「可不可以」不算——「你能不能别说话了」本身就是最常见的下命令说法）
  if (/(为什么|怎么|咋|是不是|有没有|测试|试试|试一下|测一下)/.test(t)) return null;
  // 「别说话的功能」「闭嘴的意思」这种在指代口号本身，不触发
  if (/(?:闭嘴|说话|出声|吭声|安静)的/.test(t)) return null;
  // 转述别人说过的话——在聊事，不是在下命令
  if (
    /(?:他说|她说|你说|我说|谁说|人家说|跟我说|跟我说过)[^。！？!?]{0,6}(?:闭嘴|别说话|别出声|别吭声|安静(?:点|会儿))/i.test(
      t,
    )
  ) {
    return null;
  }
  if (GROUP_MUTE_HINT_RE.test(t)) return { on: true };
  if (MUTE_OFF_RE.test(t)) return { on: false };
  return null;
}

/** 「沉默状态」这类查询口令的判据（纯文本，不解析）。 */
export function isMuteStatusQuery(text) {
  return /^(沉默状态|群里沉默了吗|还在闭嘴吗)[？?！!。.\s]*$/.test(String(text ?? "").trim());
}
