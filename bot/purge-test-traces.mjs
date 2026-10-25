// 测试痕迹清理（2026-10-25 加的，用户要的「自动清理过期的测试痕迹」）
//
// 为什么要这个：自检/探针本该零副作用，但只要有一处走了真链路，痕迹就会留在档案里。
// 今天就出了一次：`--archive-test` 调 `replyToOwnerAndArchive` → 真往主人私聊发了
// 「这是最近的新闻：遥感卫星上天了」和「晚安，宝宝」，一共 9 次半。
// 那次的档案**没被污染**（原代码有 finally 还原），但这是侥幸——它不是设计保证的。
//
// 所以这套机制管的是「以后别再漏」：
//   ① 源头已堵（--archive-test 改成只测 appendArchive，不调 reply）；
//   ② 这里做兜底：定期扫档案，把**确定是测试产物**的行摘掉。
//
// 三条硬约束（都是为了避免比问题本身更坏的结果）：
//   ① **认标记，不认猜测**。只清满足「role=me 且正文以 `【测试` / `[测试]` 开头」的行——
//      因为我们自己发测试消息时一律这么起头。**绝不**按「这句话像测试」去猜：
//      「晚安，宝宝」是她真会说的，按句子清会把真心话删掉，不可恢复。
//   ② **先备份再删**。备份失败就整次不动手；备份落在 archive/.purge-backup/<时间>/。
//   ③ **只清档案，不碰 QQ**。已经发到 QQ 上的消息撤不回（API 只支持撤最近的消息，
//      而且撤回别人客户端上的痕迹也没意义），这里只保证「她的记忆里不把测试话当真心话」。
import fs from "node:fs";
import path from "node:path";

// 测试消息的统一前缀。**这是唯一判据**。
// 加新前缀请克制：每加一条就多一分误删真心话的风险。
const TEST_PREFIXES = [/^\s*【测试/, /^\s*\[测试\]/, /^\s*\[自检\]/];

export function isTestLine(obj) {
  if (!obj || obj.role !== "me") return false;
  const t = String(obj.text ?? "");
  return TEST_PREFIXES.some((re) => re.test(t));
}

/**
 * 扫一段档案文本，分成「要摘掉的」和「留着的」。
 * 坏行（JSON 解析不了）一律**留着**——宁可留垃圾也不误删真话。
 */
export function scanArchiveText(raw) {
  const lines = String(raw ?? "").split("\n").filter(Boolean);
  const hits = [];
  const kept = [];
  for (const line of lines) {
    let hit = false;
    try {
      hit = isTestLine(JSON.parse(line));
    } catch {
      hit = false;
    }
    if (hit) hits.push(line);
    else kept.push(line);
  }
  return { total: lines.length, hits, kept };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 清一个档案文件里的测试痕迹。
 * @param {string} file 档案绝对路径
 * @param {{dryRun?:boolean, log?:Function}} opts
 * @returns {{ok:boolean, found:number, removed:number, backup?:string, reason?:string}}
 */
export function purgeArchiveFile(file, opts = {}) {
  const dryRun = opts.dryRun === true;
  const log = opts.log ?? (() => {});
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { ok: false, found: 0, removed: 0, reason: "读不到这个档案" };
  }
  const { total, hits, kept } = scanArchiveText(raw);
  if (!hits.length) return { ok: true, found: 0, removed: 0, total };

  if (dryRun) return { ok: true, found: hits.length, removed: 0, total, dryRun: true };

  // ① 先备份（失败就整次不动手）
  let backup = null;
  try {
    const dir = path.join(path.dirname(file), ".purge-backup", stamp());
    fs.mkdirSync(dir, { recursive: true });
    backup = path.join(dir, path.basename(file));
    fs.writeFileSync(backup, raw, "utf8");
  } catch (e) {
    return { ok: false, found: hits.length, removed: 0, reason: `备份失败，没敢删：${e?.message ?? e}` };
  }

  // ② 再写回
  try {
    fs.writeFileSync(file, kept.length ? kept.join("\n") + "\n" : "", "utf8");
  } catch (e) {
    return { ok: false, found: hits.length, removed: 0, reason: `写回失败：${e?.message ?? e}` };
  }

  log(`测试痕迹清理：${path.basename(file)} 摘掉 ${hits.length} 行（${total} → ${kept.length}），备份在 ${path.basename(path.dirname(backup))}/${path.basename(backup)}`);
  return { ok: true, found: hits.length, removed: hits.length, total, kept: kept.length, backup, hits };
}

/** 挂班车用：扫 home/archive 下所有 .jsonl，有就清，没有就空跑（只读一次各文件）。 */
export function purgeAllArchives({ homeDir, dryRun = false, log = () => {} }) {
  const dir = path.join(homeDir, "archive");
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return { ok: true, scanned: 0, removed: 0, files: [] };
  }
  let removed = 0;
  const details = [];
  for (const f of files) {
    const r = purgeArchiveFile(path.join(dir, f), { dryRun, log });
    if (r.removed) removed += r.removed;
    details.push({ file: f, ...r });
  }
  return { ok: true, scanned: files.length, removed, files: details };
}
