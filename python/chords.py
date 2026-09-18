"""Key and chord detection.

Reads one or more WAVs (the harmonic stems when they exist, otherwise the
mix), runs the BTC chord recognition model over them and writes a JSON file
with the key, the tempo, the beat grid and the chord segments. Progress is
printed as JSON lines like the separation scripts.
"""

import argparse
import json
import os
import sys
import time
import warnings

import numpy as np
import torch

warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))
sys.path.insert(0, HERE)

from roformer import emit, fail, load_wav  # noqa: E402

CKPT_NAME = "btc_model_large_voca.ckpt"
SAMPLE_RATE = 22050
# feature settings the model was trained with (BTC-ISMIR19 run_config.yaml)
CHUNK_SECONDS = 10.0
N_BINS = 144
BINS_PER_OCTAVE = 24
HOP_LENGTH = 2048
TIMESTEP = 108
SECONDS_PER_FRAME = CHUNK_SECONDS / TIMESTEP

MODEL_CONFIG = {
    "feature_size": N_BINS,
    "timestep": TIMESTEP,
    "num_chords": 170,
    "input_dropout": 0.2,
    "layer_dropout": 0.2,
    "attention_dropout": 0.2,
    "relu_dropout": 0.2,
    "num_layers": 8,
    "num_heads": 4,
    "hidden_size": 128,
    "total_key_depth": 128,
    "total_value_depth": 128,
    "filter_size": 128,
    "loss": "ce",
    "probs_out": False,
}

ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
QUALITIES = [
    "min", "maj", "dim", "aug", "min6", "maj6", "min7",
    "minmaj7", "maj7", "7", "dim7", "hdim7", "sus2", "sus4",
]
# the model knows 14 qualities; the rarer ones are folded into the nearest
# common chord, which reads better on a timeline and is more often right
SIMPLIFY = {
    "min6": "min", "maj6": "maj", "minmaj7": "min7",
    "dim7": "dim", "hdim7": "dim", "sus2": "sus4",
}
# no chord (silence, drums only) and unknown
NO_CHORD = "N"
# frames are about 93 ms; smoothing over this many drops the flicker that
# ambiguous passages produce without blurring real chord changes
SMOOTH_FRAMES = 7
# nothing shorter than this survives on its own
MIN_CHORD_SECONDS = 0.6

# Krumhansl and Kessler key profiles, the usual starting point for key finding
MAJOR_PROFILE = np.array(
    [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
)
MINOR_PROFILE = np.array(
    [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
)
# semitones above the tonic that belong to a major or a natural minor key
MAJOR_SCALE = {0, 2, 4, 5, 7, 9, 11}
MINOR_SCALE = {0, 2, 3, 5, 7, 8, 10}


def label_for(index):
    """the model's class index as a chord name, e.g. 'F#:min7'"""
    if index >= 168:
        return NO_CHORD
    root = ROOTS[index // 14]
    quality = QUALITIES[index % 14]
    return root if quality == "maj" else f"{root}:{quality}"


def simplify(label):
    if label == NO_CHORD or ":" not in label:
        return label
    root, quality = label.split(":", 1)
    quality = SIMPLIFY.get(quality, quality)
    return root if quality == "maj" else f"{root}:{quality}"


def smooth(labels, window=SMOOTH_FRAMES):
    """majority filter: a chord has to hold for a moment to count"""
    if len(labels) < window:
        return labels
    half = window // 2
    out = labels.copy()
    for i in range(len(labels)):
        piece = labels[max(0, i - half) : i + half + 1]
        values, counts = np.unique(piece, return_counts=True)
        out[i] = values[counts.argmax()]
    return out


def read_audio(paths):
    """sums the given WAVs to mono at the model's sample rate"""
    import torchaudio

    total = None
    rate = None
    for path in paths:
        audio, sr = load_wav(path)
        mono = torch.from_numpy(np.ascontiguousarray(audio)).mean(dim=0)
        if rate is None:
            rate, total = sr, mono
        else:
            if sr != rate:
                fail(f"{path} is {sr} Hz, expected {rate}")
            n = min(total.shape[-1], mono.shape[-1])
            total = total[:n] + mono[:n]
    if total is None:
        fail("no audio to analyse")
    if rate != SAMPLE_RATE:
        total = torchaudio.functional.resample(total, rate, SAMPLE_RATE)
    peak = float(total.abs().max())
    if peak > 0:
        total = total / peak
    return total.numpy().astype(np.float32)


def cqt_features(audio):
    """log CQT in 10 second chunks, the way the model was trained"""
    import librosa

    chunk = int(SAMPLE_RATE * CHUNK_SECONDS)
    parts = []
    for start in range(0, len(audio), chunk):
        piece = audio[start : start + chunk]
        if len(piece) < HOP_LENGTH:
            break
        parts.append(
            librosa.cqt(
                y=piece,
                sr=SAMPLE_RATE,
                n_bins=N_BINS,
                bins_per_octave=BINS_PER_OCTAVE,
                hop_length=HOP_LENGTH,
            )
        )
    if not parts:
        fail("the audio is too short to analyse")
    feature = np.concatenate(parts, axis=1)
    return np.log(np.abs(feature) + 1e-6)


def load_model(ckpt_dir, device):
    from models.btc.btc_model import BTC_model

    path = os.path.join(ckpt_dir, CKPT_NAME)
    if not os.path.exists(path):
        fail(f"the chord model is not downloaded ({CKPT_NAME})")
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    model = BTC_model(config=MODEL_CONFIG)
    model.load_state_dict(checkpoint["model"])
    model.to(device).eval()
    return model, float(checkpoint["mean"]), float(checkpoint["std"])


def predict(model, feature, mean, std, device, on_progress):
    """class index per feature frame"""
    frames = ((feature.shape[0] + TIMESTEP - 1) // TIMESTEP) * TIMESTEP
    padded = np.pad(feature, ((0, frames - feature.shape[0]), (0, 0)), mode="constant")
    padded = (padded - mean) / std
    windows = frames // TIMESTEP
    out = []
    with torch.inference_mode():
        batch = torch.tensor(padded, dtype=torch.float32, device=device).unsqueeze(0)
        for w in range(windows):
            piece = batch[:, w * TIMESTEP : (w + 1) * TIMESTEP, :]
            hidden, _ = model.self_attn_layers(piece)
            prediction, _ = model.output_layer(hidden)
            out.append(prediction.squeeze(0).cpu().numpy())
            on_progress((w + 1) / windows)
    return np.concatenate(out)[: feature.shape[0]]


def track_beats(audio):
    """tempo and beat times; chord changes are snapped to these"""
    import librosa

    try:
        tempo, beats = librosa.beat.beat_track(y=audio, sr=SAMPLE_RATE, units="time")
    except Exception:
        return None, []
    tempo = float(np.atleast_1d(tempo)[0])
    return (tempo if tempo > 0 else None), [round(float(b), 3) for b in beats]


def segments_from(labels, beats, duration):
    """turns per frame labels into chord segments. With a beat grid, each beat
    takes the chord heard most within it, which lines changes up with the
    music instead of landing mid beat"""
    times = np.arange(len(labels)) * SECONDS_PER_FRAME
    spans = []
    if len(beats) >= 8:
        edges = [0.0] + list(beats) + [duration]
        for start, end in zip(edges, edges[1:]):
            if end - start < 1e-3:
                continue
            window = labels[(times >= start) & (times < end)]
            if len(window) == 0:
                continue
            values, counts = np.unique(window, return_counts=True)
            spans.append((start, end, str(values[counts.argmax()])))
    else:
        for i, label in enumerate(labels):
            spans.append((times[i], times[i] + SECONDS_PER_FRAME, str(label)))

    merged = []
    for start, end, label in spans:
        if merged and merged[-1][2] == label:
            merged[-1][1] = end
        else:
            merged.append([start, end, label])
    # a chord shorter than a beat is usually the model wavering between two
    # readings of the same moment, so it gives way to what came before
    floor = MIN_CHORD_SECONDS
    if len(beats) >= 8:
        floor = max(floor, float(np.median(np.diff(beats))) * 0.9)
    cleaned = []
    for span in merged:
        if cleaned and cleaned[-1][2] == span[2]:
            cleaned[-1][1] = span[1]
        elif cleaned and span[1] - span[0] < floor:
            cleaned[-1][1] = span[1]
        else:
            cleaned.append(span)
    return [
        {"start": round(s, 3), "end": round(e, 3), "label": simplify(label), "raw": label}
        for s, e, label in cleaned
    ]


def chroma_from(feature):
    """12 pitch classes from the log CQT; bin 0 is C"""
    energy = np.exp(feature).sum(axis=0)
    chroma = np.zeros(12)
    for b in range(N_BINS):
        chroma[int(round(b / (BINS_PER_OCTAVE / 12))) % 12] += energy[b]
    return chroma / (chroma.sum() + 1e-9)


def score_keys(chroma, segments):
    """combines two views of the key: how the overall pitch content matches
    the classic key profiles, and how many chords fit each key"""
    scores = {}
    for tonic in range(12):
        for mode, profile, scale in (
            ("major", MAJOR_PROFILE, MAJOR_SCALE),
            ("minor", MINOR_PROFILE, MINOR_SCALE),
        ):
            rotated = np.roll(profile, tonic)
            rotated = (rotated - rotated.mean()) / (rotated.std() + 1e-9)
            centred = (chroma - chroma.mean()) / (chroma.std() + 1e-9)
            profile_score = float(np.dot(rotated, centred) / 12)

            fitting = 0.0
            total = 0.0
            for seg in segments:
                if seg["label"] == NO_CHORD:
                    continue
                span = seg["end"] - seg["start"]
                total += span
                root = ROOTS.index(seg["label"].split(":")[0])
                quality = seg["label"].split(":")[1] if ":" in seg["label"] else "maj"
                degree = (root - tonic) % 12
                if degree not in scale:
                    continue
                third = 3 if quality.startswith("min") or quality.startswith("dim") else 4
                if (degree + third) % 12 in scale:
                    fitting += span
            chord_score = fitting / total if total > 0 else 0.0
            scores[(tonic, mode)] = 0.4 * profile_score + 0.6 * chord_score
    return scores


def relative_of(tonic, mode):
    """a key and its relative share every note, so they always score alike"""
    if mode == "major":
        return (tonic + 9) % 12, "minor"
    return (tonic + 3) % 12, "major"


def detect_key(feature, segments):
    scores = score_keys(chroma_from(feature), segments)
    ranked = sorted(scores.items(), key=lambda kv: -kv[1])
    (tonic, mode), best = ranked[0]
    relative = relative_of(tonic, mode)
    # confidence measures the gap to the best key that is NOT the relative:
    # telling C major from A minor is a different question from telling it
    # from F major, and only the second one says the reading is shaky
    rival = next(score for key, score in ranked[1:] if key != relative)
    (alt_tonic, alt_mode) = ranked[1][0]
    return {
        "tonic": ROOTS[tonic],
        "mode": mode,
        "name": f"{ROOTS[tonic]} {mode}",
        "confidence": round(float(max(0.0, min(1.0, (best - rival) * 4))), 2),
        "alternative": f"{ROOTS[alt_tonic]} {alt_mode}",
        "relative": f"{ROOTS[relative[0]]} {relative[1]}",
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, nargs="+", help="WAVs to sum and analyse")
    parser.add_argument("--out", required=True, help="where to write the JSON")
    parser.add_argument("--ckpt-dir", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--source", default="", help="what the input was, for the JSON")
    args = parser.parse_args()

    device = (
        ("cuda" if torch.cuda.is_available() else "cpu") if args.device == "auto" else args.device
    )
    if device == "cuda" and not torch.cuda.is_available():
        fail("GPU engine not available (no NVIDIA GPU, or the CUDA build of torch is not installed)")

    started = time.time()
    emit(type="progress", stage="separate", pct=0, message="Listening for chords")
    audio = read_audio(args.input)
    duration = len(audio) / SAMPLE_RATE
    feature = cqt_features(audio)

    model, mean, std = load_model(args.ckpt_dir, device)
    last = [0.0]

    def report(frac):
        now = time.time()
        if now - last[0] >= 0.5:
            emit(type="progress", stage="separate", pct=min(99, int(frac * 100)))
            last[0] = now

    indices = predict(model, feature.T, mean, std, device, report)
    labels = smooth(np.array([label_for(int(i)) for i in indices]))

    tempo, beats = track_beats(audio)
    segments = segments_from(labels, beats, duration)
    key = detect_key(feature, segments)

    result = {
        "key": key,
        "tempo": round(tempo, 1) if tempo else None,
        "beats": beats,
        "segments": segments,
        "duration": round(duration, 3),
        "source": args.source,
        "model": "BTC large vocabulary",
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f)

    emit(
        type="done",
        key=key["name"],
        chords=len(segments),
        tempo=result["tempo"],
        seconds=round(time.time() - started, 1),
    )


if __name__ == "__main__":
    main()
