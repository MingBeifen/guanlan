// 活动流水落盘（2026-10-27 主人选的 B1 项）
//
// 为什么要它：在这之前，「她干过什么」只活在内存和几份互相不通的文件里——
// 发件箱发出就删了账、turns.jsonl 只有每轮一行、日志每 5MB 就轮转一次。
// 想知道「今天她主动说了几句」「昨晚有没有被预算掐过」，只能翻日志再人工数。
// 这份流水就是把「做过的事」按时间落成一条一行，谁都能读（面板/她自己/我）。
//
// 边界：只记**结果**（发出去了什么、启动一次、被掐了一次），不记思考过程、不存全文——
// 正文只留前 60 字当摘要，免得流水本身变成另一个隐私库。
// 文件只留最近 maxLines 行（默认 5000，一天几百条够存一两周）。
import fs from "node:fs";
import path from "node:path";

export function createActivityLog({ file, log = () => {}, maxLines = 5000 } = {}) {
  let lines = null; // 懒加载，第一次写才读盘
  let broken = false;

  function load() {
    if (lines) return lines;
    lines = [];
    try {
      const raw = fs.readFileSync(file, "utf8");
      lines = raw ? raw.split("\n").filter((x) => x.trim()) : [];
    } catch {
      /* 还没有这份流水：第一次写时建 */
    }
    return lines;
  }

  function append(entry) {
    if (broken) return;
    try {
      const e = {
        at: Date.now(),
        ...entry,
      };
      if (typeof e.text === "string") e.text = e.text.slice(0, 60);
      const arr = load();
      arr.push(JSON.stringify(e));
      if (arr.length > maxLines) arr.splice(0, arr.length - maxLines);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // 整份重写：行数上限是硬约束，追加模式下没法截断。
      // 5000 行 ≈ 700KB，一天写几十次，代价可以忽略。
      fs.writeFileSync(file, arr.join("\n") + "\n", "utf8");
    } catch (e) {
      broken = true;
      log("活动流水记不上（不影响回话，之后不再试）：", e?.message ?? String(e));
    }
  }

  function tail(n = 20) {
    const arr = load();
    return arr.slice(-n).map((x) => {
      try {
        return JSON.parse(x);
      } catch {
        return null;
      }
    });
  }

  return { append, tail, file };
}
