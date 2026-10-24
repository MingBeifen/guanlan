# -*- coding: utf-8 -*-
"""
观澜语音合成入口（CosyVoice3 常驻服务版）
=========================================
被 bot/whale-bot.mjs 的 synthVoice() 调用，调用接口保持不变：

    python.exe say-voice.py --text "要说的话" --out "输出.mp3" \
        --voice xxx --rate -5% --pitch -2Hz --speed 1.0 [--tone 开心]

2026-10-25 换引擎（主人拍板「直接全换掉，不要旧链路」，GPT-SoVITS 那条已停用）：
  - 模型常驻在 D:\\Software\\Tools\\CosyVoice3\\server.py（127.0.0.1:8327），
    加载一次 10.5 秒 / 3.2GB 显存；本脚本只负责「发请求 → 拿 wav → 转 mp3」。
  - 服务没起来时本脚本会自己把它拉起来（分离进程，日志 server.log），
    冷启约 12 秒，观澜那边超时是 120 秒，扛得住。
  - --voice / --rate / --pitch 是 edge-tts 时代留下的参数，照单接收、忽略。
  - --speed 真用（映射成语速倍率）。
  - --tone 真用：走 inspect2 的情绪指令（开心/委屈/生气/困/温柔…）。
    注意 CosyVoice3 带情绪指令时会小幅改写文本，这是模型行为，已告知主人。
  - --emotion-ref / --emotion-ref-text 保留兼容（旧调用方会传），现已无意义，
    情绪统一走 tone → instruct，不再换参考音文件。
"""
import os
import sys
import time
import json
import argparse
import subprocess
import tempfile
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.abspath(__file__))          # <包根>\home\voice
HOME = os.path.dirname(ROOT)                                # <包根>\home
COSY = r"D:\Software\Tools\CosyVoice3"
COSY_PY = os.path.join(COSY, "py310", "python.exe")
COSY_SERVER = os.path.join(COSY, "server.py")
COSY_LOG = os.path.join(COSY, "server.log")
# ffmpeg：2026-10-25 把 GPT-SoVITS 整合包里那份复制到了 CosyVoice3 目录，
# 不再跨盘依赖旧模型（旧链路已按主人要求整体停用）。
FFMPEG = os.path.join(COSY, "ffmpeg.exe")

HOST = "127.0.0.1"
PORT = 8327
BASE = f"http://{HOST}:{PORT}"
START_WAIT_SEC = 90          # 冷启 10.5s 加载 + 依赖 import，留足余量

# 语气词 → instruct2 指令。命中靠子串包含（「开心地笑」也算开心），所以放词根。
# 顺序有意义：越具体的越靠前。
TONE_INSTRUCT = [
    # 2026-10-25 同步 whale-bot.mjs 的 TONE_SPEED：**不能放单字「软」**（会误命中软件/软盘），
    # 单字只留「困」「累」「懒」「睡」这类不会在别的词里高频出现的。
    (["撒娇", "黏", "轻快", "俏皮", "软软", "软糯"], "用撒娇的语气说这句话。"),
    (["委屈", "难过", "失落", "低落", "伤心", "闷闷"], "用委屈难过的语气说这句话。"),
    (["生气", "赌气", "怒气", "恼", "不爽", "凶"], "用生气赌气的语气说这句话。"),
    (["困", "累", "疲惫", "懒", "睡"], "用困倦疲惫、有气无力的语气说这句话。"),
    (["温柔", "轻声", "安抚", "慢", "缓"], "用温柔轻声的语气说这句话。"),
    (["认真", "郑重", "严肃", "正经"], "用认真郑重的语气说这句话。"),
    (["开心", "高兴", "兴奋", "雀跃", "欢喜", "笑"], "用开心雀跃的语气说这句话。"),
]


def die(msg, code=1):
    print(f"[say-voice] {msg}", file=sys.stderr)
    sys.exit(code)


def instruct_for(tone):
    if not tone:
        return ""
    for words, text in TONE_INSTRUCT:
        if any(w in tone for w in words):
            return text
    return ""


def health(timeout=2):
    try:
        with urllib.request.urlopen(f"{BASE}/health", timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


def ensure_server():
    """服务在就直接用；不在就拉起来并等到 ready。"""
    h = health()
    if h and h.get("ready"):
        return h
    if not os.path.exists(COSY_PY) or not os.path.exists(COSY_SERVER):
        die(f"找不到 CosyVoice3：{COSY_PY} / {COSY_SERVER}")
    print("[say-voice] 语音服务没起来，正在拉起（约 12 秒）…", file=sys.stderr)
    # 分离进程：观澜重启不影响它；日志追加到 server.log
    creation = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    logf = open(COSY_LOG, "a", encoding="utf-8", errors="replace")
    subprocess.Popen(
        [COSY_PY, COSY_SERVER],
        cwd=COSY,
        stdout=logf,
        stderr=logf,
        creationflags=creation,
        close_fds=True,
    )
    deadline = time.time() + START_WAIT_SEC
    while time.time() < deadline:
        time.sleep(1.0)
        h = health()
        if h and h.get("ready"):
            print(f"[say-voice] 服务就绪（加载 {h.get('loadSec')}s）", file=sys.stderr)
            return h
    die(f"语音服务 {START_WAIT_SEC} 秒内没就绪，看日志：{COSY_LOG}")


def synth(text, instruct, speed):
    body = json.dumps(
        # 0.90 而不是 0.95：mp3 编码会让峰值过冲（实测 0.95 进去、0.976 出来），
        # 所以留出编码余量，保证落盘的 mp3 也不顶到 1.0。
        {"text": text, "instruct": instruct, "speed": speed, "peak": 0.90},
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{BASE}/tts",
        data=body,
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            wav = r.read()
            info = {}
            hdr = r.headers.get("X-Cosy-Info")
            if hdr:
                try:
                    info = json.loads(hdr)
                except Exception:
                    pass
            return wav, info
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:800]
        die(f"合成失败 HTTP {e.code}：{detail}")
    except Exception as e:
        die(f"合成失败（连不上语音服务）：{e}")


def main():
    # 关键：bot 传的是 "--rate -5%" 这种「值以短横线开头」的形式，argparse 默认会把它当选项，
    # 报 "argument --rate: expected one argument"。先改写成 "--rate=-5%"。
    argv = []
    i = 0
    opts = {
        "--voice", "--rate", "--pitch", "--speed", "--text", "--out",
        "--tone", "--emotion-ref", "--emotion-ref-text", "--peak",
    }
    while i < len(sys.argv):
        cur = sys.argv[i]
        if cur in opts and i + 1 < len(sys.argv):
            argv.append(f"{cur}={sys.argv[i + 1]}")
            i += 2
        else:
            argv.append(cur)
            i += 1
    sys.argv = argv

    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default="")
    ap.add_argument("--rate", default="")
    ap.add_argument("--pitch", default="")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--tone", default="")
    ap.add_argument("--emotion-ref", default="")       # 兼容旧调用方，已无意义
    ap.add_argument("--emotion-ref-text", default="")  # 同上
    args = ap.parse_args()

    text = " ".join(str(args.text).split())
    if not text:
        die("文本为空")
    if not os.path.exists(FFMPEG):
        die(f"找不到 ffmpeg：{FFMPEG}")

    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)

    ensure_server()
    instruct = instruct_for(args.tone)
    if args.emotion_ref:
        # 旧的「换参考音文件」路子已废，提示一句别让人误以为还在生效
        print("[say-voice] 注意：--emotion-ref 已停用，情绪统一走 --tone", file=sys.stderr)

    wav, info = synth(text, instruct, args.speed)

    fd, tmp_wav = tempfile.mkstemp(suffix=".wav", dir=out_dir or None)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(wav)
        r = subprocess.run(
            [FFMPEG, "-y", "-hide_banner", "-loglevel", "error",
             "-i", tmp_wav, "-codec:a", "libmp3lame", "-qscale:a", "4", args.out],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if r.returncode != 0 or not os.path.exists(args.out):
            die(f"转 mp3 失败：{(r.stderr or '')[-800:]}")
    finally:
        try:
            os.unlink(tmp_wav)
        except OSError:
            pass

    size_kb = os.path.getsize(args.out) / 1024
    print(
        f"[say-voice] ok -> {args.out} ({size_kb:.0f}KB) "
        f"tone={args.tone or '(无)'} speed={args.speed} "
        f"audio={info.get('audioSec', '?')}s rtf={info.get('rtf', '?')}x "
        f"峰值={info.get('peak', '?')}"
    )


if __name__ == "__main__":
    main()
