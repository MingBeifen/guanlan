// 开源副本脱敏脚本（2026-10-24）
// ------------------------------------------------------------
// 为什么要有这个脚本：本体 → 开源副本的每次同步都会把真实号/昵称/路径重新带回去。
// 手工 sed 一次两次还行，做多了必然漏。所以做成可重复执行的：同步完就跑一遍。
//
// 用法：
//   node desens.mjs           脱敏（就地改）
//   node desens.mjs --check   只检查，不改，有问题退出码 1
//
// 三类处理办法不一样（见全局 rules「脱敏三种目标分开处理」）：
//   ① 逻辑里的真实值 → 改成读 config / 自算路径
//   ② 注释与文档里的 → 替换成占位或通用描述
//   ③ 词表/策展词里的 → **删掉**，不要替换（占位符在真实聊天里永不出现，是纯噪音）
//   ④ UI 默认值里的   → 改成动态生成
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CHECK = process.argv.includes("--check");

// ⚠️ 真实值绝不能写在这个文件里（2026-10-24 栽过一次）。
// 这个脚本是要进公开仓库的，把「真实号 → 占位号」的映射表硬编码进来，
// 等于把要脱敏的内容本身公开发布了——第一版就是这么干的，`git show` 里能直接读到真号。
// 正确做法：映射表放**仓库外**的一个 json（默认在同级的 `.desens-map.json`，
// 已被 .gitignore 挡住），脚本运行时读它。没有映射表就只做兜底扫描。
const MAP_ENV = process.env.DESENS_MAP || "";
const MAP_FILE = MAP_ENV || path.join(ROOT, ".desens-map.json");

function loadMap() {
  let raw;
  try {
    raw = fs.readFileSync(MAP_FILE, "utf8");
  } catch {
    return { numbers: [], names: [], paths: [], ownerNames: [] };
  }
  try {
    const o = JSON.parse(raw.replace(/^\uFEFF/, ""));
    const pick = (k) =>
      Array.isArray(o[k]) && o[k].length
        ? o[k]
            .filter((p) => Array.isArray(p) && p.length === 2)
            .map(([a, b]) => [String(a), String(b)])
        : [];
    return {
      numbers: pick("numbers"),
      names: pick("names"),
      paths: pick("paths"),
      ownerNames: pick("ownerNames"),
      ownerOnly: Array.isArray(o.ownerOnly) ? o.ownerOnly.map(String).filter(Boolean) : [],
    };
  } catch (e) {
    console.error(`映射表读不动（${MAP_FILE}）：${e.message}`);
    return { numbers: [], names: [], paths: [], ownerNames: [], ownerOnly: [] };
  }
}
const MAP = loadMap();

// 需要扫的文件（只扫代码与模板，不扫 node_modules / .git / 运行数据）
const SCAN_DIRS = ["bot", "bin", "panel", "home/memory", "home/tools", "home/voice"];
const SCAN_EXT = new Set([".mjs", ".js", ".html", ".json", ".py", ".ps1", ".md", ".bat"]);
const SKIP_FILES = new Set([
  "home/memory/package-lock.json", // npm 锁文件里有大量 hash，改不得
  "home/memory/package.json",
]);
const SKIP_DIRS = new Set(["node_modules", ".git", "vectors", "migrated", "tmp", "__pycache__"]);

function walk(dir, out = []) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      if (!SCAN_EXT.has(path.extname(e.name).toLowerCase())) continue;
      const rel = path.relative(ROOT, path.join(dir, e.name)).replace(/\\/g, "/");
      if (SKIP_FILES.has(rel)) continue;
      if (/\.bak|\.orig/.test(rel)) continue;
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

// 配置类文件（这些是「逻辑」不是「注释」）：绝不能盲目替换，
// 只允许出现在 README/注释里的占位，配置里应当留空让用户填。
const CONFIG_LIKE = new Set(["config.example.json"]);

const files = [];
for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);
// 根目录的 md / json
for (const f of ["README.md", "新手引导.md", "config.example.json", "LICENSE"]) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) files.push(p);
}

let changed = 0;
const problems = [];
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  let s = fs.readFileSync(file, "utf8");
  const before = s;
  const hits = [];

  for (const [from, to] of [
    ...MAP.numbers,
    ...MAP.names,
    ...MAP.ownerNames,
    ...MAP.paths,
  ]) {
    const n = s.split(from).length - 1;
    if (n > 0) {
      hits.push(`${from}×${n}`);
      s = s.split(from).join(to);
    }
  }

  // 特殊：entity-terms 的策展词里如果混进占位符，把它们清掉。
  // 占位符形如 〔群友甲〕/〔昵称甲〕——这些在真实聊天里永远不会出现，
  // 留在策展词表里就是纯噪音，还会让实体识别多跑几次无用匹配。
  //
  // ⚠️ 2026-10-24 踩过的坑：第一版正则 `("[^"]*〔[^"〕]*〕[^"]*"\s*,?\s*)` 太宽，
  //    把文件里**正常的 path.join("memory", "vectors", "index.json")** 这种）也吃了——
  //    因为 `[^"]*` 能跨过引号之间的 `, `。结果文件语法直接坏掉。
  //    正确做法：只在 BASE 数组的字面量里做，且限定「整条就是一个带占位符的短字符串」。
  if (rel === "home/memory/entity-terms.mjs") {
    // 只处理形如  "xxx〔yyy〕zzz",  的独立数组元素
    const fixed = s
      .split("\n")
      .map((line) => {
        // 一行里可能有多个元素，逐个看：只删「整个字符串字面量含〔〕」的那种
        return line.replace(/"([^"]*〔[^"〕]*〕[^"]*)"(\s*,\s*)?/g, "");
      })
      .join("\n");
    if (fixed !== s) {
      hits.push("清掉词表里的占位符");
      s = fixed
        .replace(/,\s*,/g, ",")
        .replace(/,\s*\]/g, "]")
        .replace(/\[\s*,/g, "[");
    }
    // 词表里剩下的**单个真人名**（主人名）：这个词当实体信号没有泛化价值，
    // 而且是真实隐私，直接删掉。只删「整条就这一个词」的元素，别碰「主人」「爸爸」这类通用称呼。
    // ⚠️ 删的时候要**按行**处理并保住行尾换行——第一版直接对全文 replace，
    //    把换行一起吃掉了，下一行注释被并进数组行（语法坏掉）。
    // 词表来源也走映射表（`ownerOnly` 字段），不硬编码——同一条隐私理由。
    const OWNER_ONLY = Array.isArray(MAP.ownerOnly) ? MAP.ownerOnly : [];
    for (const w of OWNER_ONLY) {
      let touched = false;
      s = s
        .split("\n")
        .map((line) => {
          if (!line.includes(`"${w}"`)) return line;
          touched = true;
          // 优先删 ", "莹"" 这种行尾元素（保留逗号自身位置）
          let out = line.replace(new RegExp(`,\\s*"${w}"`, "g"), "");
          // 再删 "莹", 这种行首元素
          out = out.replace(new RegExp(`"${w}"\\s*,\\s*`, "g"), "");
          return out;
        })
        .join("\n");
      if (touched) hits.push(`删掉词表里的真名「${w}」`);
    }
  }

  if (s !== before) {
    changed++;
    if (CHECK) {
      problems.push(`  ${rel}: ${hits.join(", ")}`);
    } else {
      fs.writeFileSync(file, s, "utf8");
      console.log(`  ✓ ${rel}: ${hits.join(", ")}`);
    }
  }
}

// 最后再扫一遍：确认没有残留（用真实的号/名/路径正则，宽一点）
const LEFTOVER_PATTERNS = [
  [/\b\d{10}\b/g, null], // 10 位纯数字（群号/QQ 都是 10 位）
];
const ALLOWED_10 = new Set([
  "1000000001",
  "1000000002",
  "1000000003",
  "1000000004",
  "1000000005",
  "1000000006",
  "1310720000",
  // Windows 错误码：0xC0000142 的十进制写法，出现在「子进程加载 DLL 失败」的注释里，不是号码
  "3221225794",
  // 常见的时间常量（毫秒）
  "8640000000",
  "4294967296",
]);
for (const file of files) {
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  const s = fs.readFileSync(file, "utf8");
  for (const m of s.matchAll(/\b\d{10}\b/g)) {
    if (ALLOWED_10.has(m[0])) continue;
    if (/package-lock/.test(rel)) continue;
    problems.push(`  ${rel}: 可疑 10 位数字 ${m[0]}`);
  }
}

if (CHECK) {
  if (problems.length) {
    console.log("发现待脱敏内容：");
    for (const p of problems) console.log(p);
    console.log(`\n共 ${problems.length} 处。运行 node desens.mjs 就地处理。`);
    process.exit(1);
  }
  console.log("干净：没有发现真实号/昵称/路径残留");
  process.exit(0);
}

console.log(`\n已处理 ${changed} 个文件。`);
if (problems.length) {
  console.log("⚠ 仍有可疑内容需人工看：");
  for (const p of problems) console.log(p);
  process.exit(1);
}
console.log("复查通过：无残留。");
