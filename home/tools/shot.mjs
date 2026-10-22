// 整屏截图（要求截整个屏幕，不是单个窗口）
// 用法：node home\tools\shot.mjs [输出路径]
//   不给路径就存到 home\media\shot-<时间戳>.png
// 关键点：PowerShell 默认不认 DPI，系统缩放不是 100% 时会量错尺寸、左右各缺一截；
// 先 SetProcessDPIAware 再 CopyFromScreen，量到的才是真正的物理分辨率。
// 别再用「直接 Add-Type + CopyFromScreen」那套，那个就是缺一截的老毛病。
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const stamp = new Date()
  .toLocaleString("sv-SE", { hour12: false })
  .replace(/[-: ]/g, "")
  .slice(0, 14);
const out = path.resolve(process.argv[2] ?? `home/media/shot-${stamp}.png`);
fs.mkdirSync(path.dirname(out), { recursive: true });

const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class WhaleDpiFix{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();}'
[WhaleDpiFix]::SetProcessDPIAware() | Out-Null
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)
$g.Dispose()
$bmp.Save('${out.replace(/'/g, "''")}',[System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()`;

// stdio 走 inherit：沙箱里给子进程开管道会被 EPERM 挡掉，尺寸直接从 PNG 头里读。
const r = spawnSync(
  "powershell",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
  { stdio: "inherit" },
);
if (r.status !== 0 || !fs.existsSync(out)) {
  console.log("截图失败:", (r.error?.message ?? "").slice(0, 200));
  process.exit(1);
}
const buf = fs.readFileSync(out);
const w = buf.readUInt32BE(16);
const h = buf.readUInt32BE(20);
console.log(`${out} ${w}x${h} ${Math.round(buf.length / 1024)}KB`);
