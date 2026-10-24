# -*- coding: utf-8 -*-
"""观澜 · 语音转文字（本地 funasr，不联网、不花钱、不占显存）

被 bot/whale-bot.mjs 的 transcribeAudio() 调用：

    python.exe transcribe.py --audio "某条语音.mp3" [--out 结果.txt]

stdout 打印一行 JSON：{"ok":true,"text":"...","ms":1234}
出错时 {"ok":false,"error":"..."} 并以退出码 1 结束。

为什么换成 funasr（2026-10-25）：
  原来那套是 whisper.cpp 的 CLI（-m model.bin -otxt -of），但本机
  ①没有 whisper 二进制（where whisper 为空）
  ②CFG.voiceWhisper 被写死成空串、config.json 里也压根没有这两个字段
  ③还要依赖 home/tools/zh-simp.mjs 转简体，那个文件也不存在
  → 三条断链叠在一起，收到的语音一律变成 [语音] 占位，一个字都听不到。
  funasr 这套模型本来就在本机（训练/校验参考音时装的），paraformer-large + fsmn-vad + punc，
  实测 13.4 秒转一句中文，结果直接就是简体中文、自带标点，不需要二次转换。

模型位置：<本目录>/asr/models（1.2G），随 CosyVoice3 一起放的；找不到就报错，不瞎猜。
"""
import sys, os, json, argparse, time

HERE = os.path.dirname(os.path.abspath(__file__))
# 默认去 CosyVoice3 那边找模型；可用 --models 或环境变量 WW_ASR_MODELS 覆盖
DEFAULT_MODELS = r"D:\Software\Tools\CosyVoice3\asr\models"
MODEL_DIRS = {
    "asr": "speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    "vad": "speech_fsmn_vad_zh-cn-16k-common-pytorch",
    "punc": "punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
}


def fail(msg, code=1):
    print(json.dumps({"ok": False, "error": msg}, ensure_ascii=False))
    sys.exit(code)


def pick_models_dir(explicit=""):
    for cand in [explicit, os.environ.get("WW_ASR_MODELS", ""), DEFAULT_MODELS]:
        if not cand:
            continue
        if all(os.path.isdir(os.path.join(cand, d)) for d in MODEL_DIRS.values()):
            return cand
    fail(
        "找不到 ASR 模型目录（需要含 "
        + " / ".join(MODEL_DIRS.values())
        + f"）；试过：{explicit or '(未指定)'} / {DEFAULT_MODELS}"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True, help="要转写的音频文件（任意格式，ffmpeg 会转）")
    ap.add_argument("--models", default="", help="ASR 模型根目录")
    ap.add_argument("--out", default="", help="把结果也写一份到这个文件")
    # say-voice.py 那种「值以短横线开头」的兼容：这里参数都是路径，不处理
    args = ap.parse_args()

    if not os.path.isfile(args.audio):
        fail(f"音频不存在：{args.audio}")

    models = pick_models_dir(args.models)

    # 关键：funasr 首次 import 会打印版本号等噪音到 stdout，会污染 JSON。
    # 先把 stdout 重定向到 stderr，输出结果前再换回来。
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        t0 = time.time()
        from funasr import AutoModel

        m = AutoModel(
            model=os.path.join(models, MODEL_DIRS["asr"]),
            vad_model=os.path.join(models, MODEL_DIRS["vad"]),
            punc_model=os.path.join(models, MODEL_DIRS["punc"]),
            disable_update=True,
        )
        r = m.generate(input=args.audio, batch_size_s=300)
        text = "".join(str(x.get("text", "")) for x in r).strip()
        ms = int((time.time() - t0) * 1000)
    except Exception as e:
        sys.stdout = real_stdout
        fail(f"转写失败：{type(e).__name__}: {e}")
    finally:
        sys.stdout = real_stdout

    if not text:
        print(json.dumps({"ok": False, "error": "没转出任何字（可能是纯音乐/静音）", "ms": ms}, ensure_ascii=False))
        sys.exit(2)

    if args.out:
        try:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(text)
        except OSError as e:
            print(json.dumps({"ok": True, "text": text, "ms": ms, "warn": f"写文件失败：{e}"}, ensure_ascii=False))
            return

    print(json.dumps({"ok": True, "text": text, "ms": ms}, ensure_ascii=False))


if __name__ == "__main__":
    main()
