"""Lyrics timed to the singing.

Takes lyrics found on LRCLIB (lines with times, or plain text) and the
song's vocals stem, and works out when each word is sung: wav2vec2 (base,
960 h of LibriSpeech, Apache 2.0, English letters) hears letters frame by
frame, and a CTC forced alignment finds the best path through those frames
that spells the lyrics in order. Lines that LRCLIB already timed are
aligned one at a time inside their own stretch, which keeps one bad line
from dragging the rest; plain lyrics are aligned across the whole song.

Lines the model cannot follow (another language, a mumbled line) keep the
line's own times with the words spread evenly, and are marked estimated.
Progress is printed as JSON lines like the other scripts.
"""

import argparse
import json
import os
import re
import sys
import time
import unicodedata
import warnings

import numpy as np

warnings.filterwarnings("ignore")

# A container often runs as an arbitrary uid with no /etc/passwd entry (Unraid
# uses 99). transformers and getpass look the running user up by uid, which
# raises "uid not found" and would fail loading. On POSIX, set the usual
# environment and give such a lookup a fallback so it cannot crash.
try:
    import pwd as _pwd
except ImportError:
    _pwd = None  # Windows dev box: no pwd module, getpass uses USERNAME
if _pwd is not None:
    os.environ.setdefault("HOME", os.environ.get("TMPDIR") or "/tmp")
    os.environ.setdefault("USER", "stemkit")
    os.environ.setdefault("LOGNAME", "stemkit")
    _real_getpwuid = _pwd.getpwuid

    def _getpwuid(uid):
        try:
            return _real_getpwuid(uid)
        except KeyError:
            return _pwd.struct_passwd(
                ("stemkit", "x", uid, os.getgid(), "StemKit", os.environ["HOME"], "/bin/sh")
            )

    _pwd.getpwuid = _getpwuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from wavio import read_any  # noqa: E402

CHECKPOINT = "wav2vec2-base-960h.safetensors"
MODEL_LABEL = "wav2vec2 base 960h"
SAMPLE_RATE = 16000
FRAME = 320 / SAMPLE_RATE  # one model frame is 20 ms
CHUNK_SECONDS = 20

# facebook/wav2vec2-base-960h vocab.json
VOCAB = {"<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3, "|": 4, "E": 5, "T": 6, "A": 7, "O": 8, "N": 9,
         "I": 10, "H": 11, "S": 12, "R": 13, "D": 14, "L": 15, "U": 16, "M": 17, "W": 18, "C": 19,
         "F": 20, "G": 21, "Y": 22, "P": 23, "B": 24, "V": 25, "K": 26, "'": 27, "X": 28, "J": 29,
         "Q": 30, "Z": 31}
BLANK = 0
SPACE = VOCAB["|"]

# slack around an LRCLIB line's own times: user-made times are often a
# little early or late
SLACK_BEFORE = 0.6
SLACK_AFTER = 0.6
# a line with no next line rings on at most this long
LAST_LINE = 6.0
# below this average log probability per letter the alignment is a guess
MIN_SCORE = -4.5
# a word stays lit until the next one starts, or this long after its last letter
WORD_TAIL = 0.45
# the longest a single word can run: across a gap the last letter can latch
# onto later audio, so cap it rather than let one word swallow a bridge
WORD_MAX = 2.5


def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)


def fail(message):
    emit(type="error", message=str(message))
    sys.exit(1)


# ---------- lyrics text ----------

LRC_TIME = re.compile(r"\[(\d+):(\d+(?:\.\d+)?)\]")


def parse_lrc(text):
    """[(seconds, line)] from LRC text, in order; a line can carry several times"""
    out = []
    for raw in text.splitlines():
        times = LRC_TIME.findall(raw)
        if not times:
            continue
        words = LRC_TIME.sub("", raw).strip()
        for m, s in times:
            out.append((int(m) * 60 + float(s), words))
    out.sort(key=lambda x: x[0])
    return out


def letters(word):
    """a word as the model's letters: accents dropped, upper case"""
    word = unicodedata.normalize("NFKD", word)
    word = "".join(c for c in word if not unicodedata.combining(c))
    word = word.replace("’", "'").replace("`", "'").upper()
    return "".join(c for c in word if c in VOCAB and len(c) == 1 and c != "|").strip("'")


def tokens_for(words):
    """the model tokens spelling the words, with a word break between each,
    and which token each word starts and ends on"""
    tokens = []
    spans = []
    for w in words:
        spelled = letters(w)
        if not spelled:
            spans.append(None)
            continue
        if tokens:
            tokens.append(SPACE)
        start = len(tokens)
        tokens.extend(VOCAB[c] for c in spelled)
        spans.append((start, len(tokens) - 1))
    return tokens, spans


# ---------- model ----------


def load_model(models_dir, device):
    import torch
    from safetensors.torch import load_file
    from transformers import Wav2Vec2Config, Wav2Vec2ForCTC

    config = Wav2Vec2Config(vocab_size=32, pad_token_id=0, bos_token_id=1, eos_token_id=2)
    model = Wav2Vec2ForCTC(config)
    state = load_file(os.path.join(models_dir, CHECKPOINT))
    missing, _ = model.load_state_dict(state, strict=False)
    missing = [k for k in missing if "masked_spec_embed" not in k]
    if missing:
        raise RuntimeError(f"the alignment model is missing weights: {missing[:3]}")
    return model.to(device).eval()


def emissions(model, audio, on_progress):
    """log probabilities of each letter, one row per 20 ms"""
    import torch

    rows = []
    step = CHUNK_SECONDS * SAMPLE_RATE
    total = max(1, len(audio))
    with torch.inference_mode():
        for start in range(0, len(audio), step):
            chunk = audio[start : start + step]
            if len(chunk) < 400:
                break
            # the feature extractor's normalisation
            chunk = (chunk - chunk.mean()) / (chunk.std() + 1e-7)
            x = torch.from_numpy(chunk.astype(np.float32)).unsqueeze(0).to(model.device)
            logits = model(x).logits[0]
            rows.append(torch.log_softmax(logits.float(), dim=-1).cpu().numpy())
            on_progress(min(1.0, (start + step) / total))
    return np.concatenate(rows) if rows else np.zeros((0, 32), np.float32)


# ---------- alignment ----------


def force_align(em, tokens):
    """CTC forced alignment: the frame each token is heard on, on the most
    likely path that spells the tokens in order with blanks between and
    around them. None when the stretch is too short to hold them"""
    T, J = len(em), len(tokens)
    if J == 0 or T < J:
        return None, None
    blank = em[:, BLANK]
    tok = em[:, tokens]  # (T, J)
    trellis = np.full((T + 1, J + 1), -np.inf, dtype=np.float32)
    trellis[0, 0] = 0.0
    trellis[1:, 0] = np.cumsum(blank)
    moved = np.zeros((T + 1, J + 1), dtype=bool)
    for t in range(1, T + 1):
        stay = trellis[t - 1, 1:] + blank[t - 1]
        move = trellis[t - 1, :-1] + tok[t - 1]
        better = move > stay
        trellis[t, 1:] = np.where(better, move, stay)
        moved[t, 1:] = better
    if not np.isfinite(trellis[T, J]):
        return None, None
    frames = np.zeros(J, dtype=np.int64)
    t, j = T, J
    while j > 0 and t > 0:
        if moved[t, j]:
            frames[j - 1] = t - 1
            j -= 1
        t -= 1
    score = float(np.mean(tok[frames, np.arange(J)]))
    return frames, score


def spread(words, start, end):
    """words laid evenly over a line, by length"""
    weights = [max(1, len(letters(w))) for w in words]
    total = sum(weights)
    out = []
    t = start
    for w, weight in zip(words, weights):
        d = (end - start) * weight / total
        out.append({"start": round(t, 3), "end": round(t + d, 3), "text": w})
        t += d
    return out


def place_words(words, spans, frames, offset, line_end):
    """word times from the frames their letters were heard on; words with
    no letters (numbers, symbols) sit between their neighbours"""
    times = []
    for span in spans:
        if span is None:
            times.append(None)
        else:
            a, b = span
            s = offset + frames[a] * FRAME
            e = offset + (frames[b] + 1) * FRAME
            times.append((s, min(e, s + WORD_MAX)))
    out = []
    for i, (w, tm) in enumerate(zip(words, times)):
        if tm is None:
            prev = next((times[k][1] for k in range(i - 1, -1, -1) if times[k]), None)
            nxt = next((times[k][0] for k in range(i + 1, len(times)) if times[k]), None)
            s = prev if prev is not None else (nxt if nxt is not None else offset)
            e = nxt if nxt is not None else s + 0.3
            tm = (s, max(s + 0.05, e))
        out.append({"start": tm[0], "end": tm[1], "text": w})
    # a word stays lit until the next one, within reason
    for i, w in enumerate(out):
        nxt = out[i + 1]["start"] if i + 1 < len(out) else line_end
        w["end"] = round(max(w["end"], min(nxt, w["end"] + WORD_TAIL)), 3)
        w["start"] = round(w["start"], 3)
    return out


def align_synced(em, timed, duration, on_progress):
    """lines LRCLIB timed: each aligned within its own stretch"""
    lines = []
    for i, (start, text) in enumerate(timed):
        if not text:
            continue
        nxt = next((t for t, _ in timed[i + 1 :]), None)
        end = min(nxt if nxt is not None else start + LAST_LINE, duration or 1e9)
        end = max(end, start + 0.3)
        words = text.split()
        tokens, spans = tokens_for(words)
        lo = max(0, int((start - SLACK_BEFORE) / FRAME))
        hi = min(len(em), int((end + SLACK_AFTER) / FRAME))
        frames, score = force_align(em[lo:hi], tokens) if len(em) else (None, None)
        if frames is not None and score >= MIN_SCORE:
            placed = place_words(words, spans, frames, lo * FRAME, end + SLACK_AFTER)
            line = {"start": placed[0]["start"], "end": round(max(placed[-1]["end"], placed[0]["start"]), 3),
                    "text": text, "words": placed}
        else:
            line = {"start": round(start, 3), "end": round(end, 3), "text": text,
                    "words": spread(words, start, end), "estimated": True}
        lines.append(line)
        on_progress((i + 1) / len(timed))
    return lines


def align_plain(em, text):
    """plain lyrics: one alignment across the whole song"""
    raw = [l.strip() for l in text.splitlines() if l.strip()]
    all_words = []
    owner = []
    for n, line in enumerate(raw):
        for w in line.split():
            all_words.append(w)
            owner.append(n)
    tokens, spans = tokens_for(all_words)
    frames, score = force_align(em, tokens)
    if frames is None or score < MIN_SCORE:
        return None
    placed = place_words(all_words, spans, frames, 0.0, len(em) * FRAME)
    lines = []
    for n, line in enumerate(raw):
        ws = [w for w, o in zip(placed, owner) if o == n]
        if not ws:
            continue
        lines.append({"start": ws[0]["start"], "end": ws[-1]["end"], "text": line, "words": ws})
    return lines


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--lyrics", required=True, help="the LRCLIB record, as JSON")
    parser.add_argument("--vocals", default="", help="the vocals stem; without it, line times only")
    parser.add_argument("--out", required=True)
    parser.add_argument("--ckpt-dir", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--duration", type=float, default=0.0)
    args = parser.parse_args()

    started = time.time()
    with open(args.lyrics, encoding="utf-8") as f:
        record = json.load(f)
    synced = (record.get("syncedLyrics") or "").strip()
    plain = (record.get("plainLyrics") or "").strip()
    timed = parse_lrc(synced) if synced else []
    duration = args.duration or float(record.get("duration") or 0)

    em = np.zeros((0, 32), np.float32)
    device = "cpu"
    if args.vocals and (timed or plain):
        emit(type="progress", stage="separate", pct=0, message="Listening to the vocals")
        try:
            import torch

            device = args.device if args.device == "cpu" or torch.cuda.is_available() else "cpu"
            model = load_model(args.ckpt_dir, device)
            audio, sr = read_any(args.vocals)
            mono = audio.mean(axis=0).astype(np.float32)
            import torchaudio

            mono = torchaudio.functional.resample(torch.from_numpy(mono), sr, SAMPLE_RATE).numpy()
            duration = duration or len(mono) / SAMPLE_RATE
            em = emissions(model, mono, lambda frac: emit(type="progress", stage="separate", pct=int(frac * 70)))
        except Exception as err:  # noqa: BLE001
            # line times from LRCLIB still work without the model
            emit(type="progress", stage="separate", pct=70, message=f"Word timing skipped: {err}")
            em = np.zeros((0, 32), np.float32)

    emit(type="progress", stage="separate", pct=75, message="Lining up the words")
    lines = None
    aligned = len(em) > 0
    if timed:
        lines = align_synced(em, timed, duration, lambda frac: None)
    elif plain and aligned:
        lines = align_plain(em, plain)
    if lines is None:
        # plain lyrics the model could not follow: shown, but not timed
        lines = [{"text": l.strip(), "words": []} for l in plain.splitlines() if l.strip()]
        aligned = False

    result = {
        "source": "LRCLIB",
        "id": record.get("id"),
        "artist": record.get("artistName"),
        "track": record.get("trackName"),
        "album": record.get("albumName"),
        "instrumental": bool(record.get("instrumental")),
        "synced": bool(timed),
        "aligned": aligned and any(not l.get("estimated") and l.get("words") for l in lines),
        "lines": lines,
        "model": MODEL_LABEL if aligned else None,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    estimated = sum(1 for l in lines if l.get("estimated"))
    emit(type="done", lines=len(lines), estimated=estimated, seconds=round(time.time() - started, 1), device=device)


if __name__ == "__main__":
    main()
