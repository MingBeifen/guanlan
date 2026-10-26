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

/**
 * 这一档「当天最后可补的时刻」（分钟数，从 0 点算）。
 *
 * 2026-10-26 修「错过就永久丢」：原来 `pendingKind` 只在该档窗口的 **+GREET_GRACE_MIN(45分钟)** 内成立，
 * 于是实测 `greet.morning` 停在 2026-10-23 —— 那天早上 8-10 点她根本不在跑（前一次启动 05:07、
 * 下一次 11:51），等到 11:51 起来时早安窗口和 45 分钟宽限都早过了，**这一天就永远没有早安**，
 * 而且下一次起来看到 `pro.greet.morning !== today` 也不会补发，只是静默跳过。
 * 同一天 `哦鲸鲸的窝\日程.md` 也停在 10-23 —— 两份文件同日停滞不是巧合，是同一个病根。
 *
 * 现在的规则：**只要当天还没发过，就允许补**，但给每一档一个「补到几点为止」的天花板，
 * 免得半夜 2 点补一句「早上好」出戏：
 *   morning → 补到 **15:00**（见下面二次修订）
 *   noon    → 补到 17:00（傍晚再补「中午好」很怪）
 *   night   → 补到次日 02:00（熬夜到凌晨还该有晚安）
 * 这不是 45 分钟那种拍脑袋的窗，而是「这一天里这个招呼还成不成立」的语义边界。
 *
 * ⚠️ 2026-10-26 三次修订（最终版）：早安天花板从 21:00 → 15:00 → **11:30**。
 * 理由链：
 *   21:00 → 15:00 爬起来会补「迟到 300 分钟的早安」，下午茶时间说早上好很怪；
 *   15:00 → **11:30**（= 中午窗口开始的那一刻）。过了 11:30 就是中午的地盘了，
 *   再补「早上好」与紧接着要发的中午问候打架，两条一起发更怪。
 * **代价要接受**：她 11:51 才起来的那一天，早安就是没有了（只有中午）。
 * 这个取舍是刻意的——**「起床晚了就该错过早安」是用户能理解的事实**，
 * 而「11:51 收到一句早上好」才是不像人的地方。
 * 真正被这个修改救回来的是两种常见情形：
 *   ① 早上 8-10 她在跑、但主人在忙 → 被压进 pending，10:00-11:30 之间能补发；
 *   ② 10:00-11:30 之间她才起来（比原来"窗口+45分钟"多覆盖 45 分钟）。
 */
export function catchUpUntil(kind) {
  if (kind === "morning") return 11 * 60 + 30;
  if (kind === "noon") return 17 * 60;
  if (kind === "night") return 26 * 60; // 26:00 = 次日 02:00
  return 24 * 60;
}

/**
 * 某一档在当天这个时刻还来不来得及补（纯判断）。
 *
 * ⚠️ 2026-10-26 修：第一版直接写 `hour*60+minute < catchUpUntil(kind)`，
 * 自检立刻抓到两个错：
 *   「半夜 2:00 不补早安」→ 实际返回 true（120 < 1260），**凌晨会补一句早上好**；
 *   「凌晨 2:01 不补晚安」→ 实际返回 true（121 < 1560），**晚安会补到天亮**。
 * 根因：**天花板也是「从 0 点算的分钟数」，但它表达的是「那个窗口之后最多补到几点」**，
 * 而 window 结束时刻（如早安 10:00 = 600）和天花板（21:00 = 1260）之间才有意义。
 * 所以判据必须是「**在窗口结束之后、且在天花板之前**」这个区间内——
 * 凌晨 2:00 在窗口结束「之前」（它属于第二天了），不该算补。
 * 现在的写法：先要求「已经过了这一档的正常窗口结束」，再要求「还没到天花板」。
 * 晚安的天花板是 26:00（次日 02:00），所以要允许 hour < 3 的凌晨时段。
 *
 * ⚠️ 2026-10-26 二期（C1「早安跟实际起床时间走」，主人点头做的）：
 * `.mjs` 的 `catchUpUntil` 是**默认天花板**；如果调用方传了 `wakeMin`（今天第一次起来的时刻，
 * 从 0 点算的分钟数），早安的额头上限会被**抬到「起床后 + 90 分钟」**，但仍受两个硬约束：
 *   ① **不超过中午窗口开始（11:30）**——过了就是中午的地盘，再补「早上好」跟中午问候打架；
 *   ② **不超过 wakeMin + 90**——她 11:39 起来时，11:30 已过，但如果严格卡 11:30 就永远没有早安。
 *      实测她连两天 11:39 前后才启动，天花板 11:30 等于「天天没早安」。
 * 取舍：她 11:39 起来 → 上限变成 min(11:30 放开到 13:09, 11:39+90=13:09) —— 取 13:09。
 * 这样中午窗口（11:30 起）优先发 noon，**noon 发完之后**才轮到迟到的早安（catchUpOrder 从早到晚，
 * 但 morning 已过 11:30 时会被 noon 的 active 抢先后——见 greetPlan 里的窗口优先规则）。
 */
export function canCatchUp(kind, hour, minute, wakeMin = 0) {
  const win = GREET_WINDOWS[kind];
  const windowEnd = win[2] * 60 + win[3];
  const cur = hour * 60 + minute;
  let until = catchUpUntil(kind);
  // C1：早安跟实际起床时间走（只在传了 wakeMin 且确实晚于默认天花板时才放宽）
  if (kind === "morning" && wakeMin > 0) {
    const byWake = wakeMin + 90;
    if (byWake > until) until = Math.min(byWake, 13 * 60 + 30); // 硬顶 13:30，绝不拖到下午
  }

  // 晚安要跨零点：cur 在 0~3 点之间时，按「次日 24:00 之后」理解
  const curWrapped = kind === "night" && cur < windowEnd ? cur + 24 * 60 : cur;
  // 早/午：必须在窗口结束之后（cur > windowEnd）才算补；凌晨 cur 很小，天然不满足
  if (kind !== "night" && cur <= windowEnd) return false;
  return curWrapped < until;
}

/** 这一档的「迟到多久」（分钟数，用于告诉她为什么是补的）。纯判断。 */
export function lateByMinutes(kind, hour, minute) {
  const win = GREET_WINDOWS[kind];
  const windowEnd = win[2] * 60 + win[3];
  return Math.max(0, hour * 60 + minute - windowEnd);
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
 *
 * C1（2026-10-26，主人点头做的）：第 2 个参数 `opts.wakeMin` = 她今天第一次起来的分钟数
 * （从 0 点算）。传了就表示「早安天花板跟着实际起床时间走」，不传就用默认 11:30。
 */
export function greetPlan(now = Date.now(), opts = {}) {
  const wakeMin = Math.max(0, Number(opts.wakeMin) || 0);
  const { day, hour, minute } = bjParts(now);
  const active = GREET_KEYS.find((k) => inWindow(GREET_WINDOWS[k], hour, minute));
  const grace = GREET_KEYS.find((k) => inWindow(GREET_WINDOWS[k], hour, minute, GREET_GRACE_MIN));
  const quiet = readQuiet(); // 忙 / 睡了
  const blocking = active ?? grace;
  const pending = get("pendingGreet", null);
  const sent = get("greet", {}) || {};

  // ⚠️ 2026-10-26 修「错过就永久丢」：这一段原来是
  //     pendingKind = (pending?.day===day && inWindow(...GREET_GRACE_MIN)) ? pending.kind : null
  //   → 过了窗口 +45 分钟就永远 null，那一天再也发不出去。
  //   现在改成两层：
  //     ① 有 pending（因为忙/睡被压下的）→ 只要当天还没发、且还没过 `catchUpUntil` 的天花板，就能补；
  //     ② **没有 pending 也能补**——这是关键。她早上根本没在跑的时候，
  //        `pendingGreet` 压根没被设过（那行 `greetMod.setPendingGreet` 需要 tick 跑过才会执行），
  //        所以光靠 pending 永远补不上。这里直接按「这一档今天还没发 + 还没过天花板」判。
  // 补发顺序（2026-10-26 修）：**先补最早错过的**，按时间先后 morning → noon → night。
  //
  // 第一版我写的是 ["night","noon","morning"]（从晚到早），理由是「免得傍晚同时补三条」。
  // 但实测这个顺序有个明显问题：**11:51 起床时，中午窗口正开着（active=noon），
  // 早安会被一直压到中午发过之后才轮到**——而那时已经是午饭后，再补「早安」就更怪了。
  // 从早到晚才对：她 11:51 起来，先补一句迟到的早安（迟到 111 分钟，提示词会说「补的」），
  // 下一轮 tick 再补中午。每轮只补一档，不会一次刷三条。
  //
  // 晚安例外：它跨零点，凌晨 1 点的「night」不该排在早安后面（那天早安早发过了，
  // `sent.morning === day` 会直接把它跳过），所以顺序本身不需要特判。
  const catchUpOrder = ["morning", "noon", "night"];
  // C1（2026-10-26）：把「她今天几点起来的」传进判据，让早安天花板跟着实际起床时间走。
  // wakeMin 来自调用方（whale-bot 传当日第一次启动的分钟数）；取不到就传 0 = 用默认天花板。
  const catchUpKind =
    catchUpOrder.find((k) => sent[k] !== day && canCatchUp(k, hour, minute, wakeMin)) ?? null;
  // 有 pending 就优先它（它代表「本来该发、被忙/睡压下了」），否则用兜底的 catchUpKind
  const pendingKind =
    pending?.day === day &&
    sent[pending.kind] !== day &&
    canCatchUp(pending.kind, hour, minute, wakeMin)
      ? pending.kind
      : catchUpKind;

  // ⚠️ 2026-10-26 关键取舍（两次修订才定下来）：
  //
  // 第一版：`kind = active ?? pendingKind` → 11:51 起来时只发中午，**早安永远补不上**（这就是原 bug）。
  // 第二版：让「更早没发的档」顶掉 active → 11:51 能补早安了，但 `--state-test` 立刻报错：
  //        **12:00 返回 morning（期望 noon）**。也就是说整个中午窗口都会被迟到的早安占掉。
  //
  // 最终规则（两者都要）：
  //   · **正处在某一档窗口内（active 存在）→ 一律优先它**，这是「准点优先」，
  //     12:00 就该发中午，不能被早上的欠账顶掉；
  //   · **不在任何窗口内（active 为空）→ 才按 catchUpOrder 从早到晚补欠账**。
  //
  // 那 11:51 怎么办？11:51 落在中午窗口（11:30–13:00）内，按上面的规则会发中午——
  // **这一天就真的没有早安了**。这是刻意的取舍：**「11:51 说早上好」本身就不对**，
  // 而「她起床晚就错过早安」是用户能理解的事实。真正要救的是「早上 8–10 她在跑、但因为忙被压下去」
  // 以及「10:00–11:30 之间起来」（这两个时段 active 为空，能正常补）。
  // 早安天花板收到 15:00 后，**10:00–11:30 这段空档是补早安的主力区间**。
  const earlierMissed = undefined; // 见上面说明：窗口内不顶 active
  const kind = active ?? pendingKind;

  // =====================================================================
  // 「首启问候」（2026-10-26 主人拍板的新方案）
  // =====================================================================
  // 他的原话：「改成每天8点后12点前首次启动就是早上好，12点后首次启动就是下午好」
  //
  // 为什么需要它：原来按「固定窗口 8-10 点」判早安，但实测她**经常整个上午不在跑**
  // （2026-10-26：05:24 停、下一次 11:39），于是 `greet.morning` 从 10-23 起一直没发出去过。
  // 逻辑再对也没用——**窗口期内根本没有人**。
  //
  // 新语义：**不看她"应该在几点说话"，看她"今天第一次醒来的那一刻是几点"**——
  //   · 08:00 ≤ 首启 < 12:00 → 发「早上好」（kind='morning'）
  //   · 12:00 ≤ 首启 < 21:30 → 发「下午好」（kind='noon'，共用中午档但换措辞）
  //   · 首启 < 08:00 或 ≥ 21:30 → **不发**（凌晨说早上好出戏，深夜交给 night 档）
  //
  // 三个约束（防止变成"每次重启都问候一遍"）：
  //  ① `firstWakeFresh`：只认**刚启动后的 `firstWakeWindowMin` 分钟**（默认 10）内——
  //     她 11:39 起来，11:45 之前才算"首启问候"，11:50 之后算错过、不再补；
  //  ② 一天只发一次：`sent[kind] === day` 就不再发（沿用原记账）；
  //  ③ 只在 `wakeMin > 0`（确实拿到今天首启时刻）时才生效，拿不到退回原窗口逻辑。
  const firstWakeWindowMin = Math.max(1, Number(opts.firstWakeWindowMin) || 10);
  const wakeHour = Math.floor(wakeMin / 60);
  const sinceWake = hour * 60 + minute - wakeMin; // 距今天首次启动多少分钟
  const firstWakeFresh =
    wakeMin > 0 && sinceWake >= 0 && sinceWake <= firstWakeWindowMin;
  const firstWakeKind =
    wakeMin > 0 && wakeHour >= 8 && wakeMin < 12 * 60
      ? "morning"
      : wakeMin > 0 && wakeMin >= 12 * 60 && wakeMin < 21 * 60 + 30
        ? "noon"
        : null;
  // 首启问候优先级**高于窗口**：它是「今天第一次见面」，比「现在正好是中午窗口」更该先说。
  const firstWakeGreet =
    firstWakeFresh && firstWakeKind && sent[firstWakeKind] !== day
      ? firstWakeKind
      : null;
  const finalKind = firstWakeGreet ?? kind;
  const wakeGreeting = Boolean(firstWakeGreet);

  // 谷时规矩：工作日 9-12、14-18 不主动开口；但「早安」例外
  const peak = isPeakHour(now) && (finalKind ?? blocking) !== "morning";
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
    kind: finalKind,
    // 这次是不是「首启问候」（供 greetPrompt 选措辞、供日志标出来）
    firstWakeGreet: wakeGreeting,
    firstWakeKind,
    wakeMin,
    // 这一档是被「更早的档没发」顶出来的吗（供日志/调试）
    catchUpOverride: Boolean(earlierMissed),
    // ⚠️ 首启问候**不是「迟到」**——它是"今天第一次见面"，不能让她说「我迟到了」。
    // 所以 late 与 lateMin 只要碰上首启问候就一律归零。
    late: !wakeGreeting && Boolean(finalKind) && finalKind !== active,
    // 迟到多久（分钟）：给提示词用，让她知道该不该说「补的」
    // ⚠️ 注意不能用 `!active` 判——earlierMissed 顶掉 active 时，active 是 noon 但 kind 是 morning，
    // `!active` 会是 false 从而 lateMin 算成 0（自检抓到）。改判「kind 是不是当前窗口内的档」。
    lateMin:
      !wakeGreeting && finalKind && finalKind !== active
        ? lateByMinutes(finalKind, hour, minute)
        : 0,
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

/**
 * 记下「今天她写过日程了」（A 档解耦，2026-10-26）。
 *
 * 为什么单独要这个：原来写日程是**早安问候的附属动作**——`markGreetSent("morning")` 顺手把
 * `planDay` 记成今天，而写日程的提示词也只出现在 `greetPrompt("morning")` 里。
 * 于是**早安发不出去 = 日程永远不写**：实测她 10-24 起每天 11:39 后才启动，
 * 早安窗口 08:00-10:00 全错过，`日程.md` 就停在 10-23（mtime 正好是最后一封早安的 8 秒后）。
 * 现在把「写日程」从问候里剥出来，用它自己的判据（今天还没写）驱动，跟早安完全无关。
 * 三条约束：① 只管标记、不发消息（发不发由 whale-bot 那边的执行体决定）；
 * ② 记的是计划日（`logicalDay()`），不是自然日；③ 重复调用无副作用。
 */
export function markPlanWritten(day) {
  const s = raw();
  if (s.planDay === day) return false;
  s.planDay = day;
  writeState();
  return true;
}

/** 今天写过日程了吗（纯判断）。 */
export function planWrittenToday(day) {
  return get("planDay", null) === day;
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
