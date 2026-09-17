"""Separation with Music-Source-Separation-Training style models.

Runs one model over a WAV file and writes the requested stems as 32-bit float
WAVs. Progress is printed as JSON lines in the same format as separate.py and
roformer.py, so the server reads all three the same way.

Models (checkpoints live in --ckpt-dir, configs in ./configs):
  bs_roformer_sw  6 stems: bass, drums, other, vocals, guitar, piano
  drumsep         a drums stem split into kick, snare, toms, hihat, ride, crash
"""

import argparse
import contextlib
import os
import sys
import time
import warnings

import numpy as np
import torch
import yaml

# torch and the vendored models warn about deprecations and STFT windows on
# every run; the server shows the last stderr lines when a split fails, so
# keep stderr for real errors
warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "vendor"))
sys.path.insert(0, HERE)

# emit/fail/wav helpers and the CUDA attention override are shared with the
# vocals script
from roformer import apply_attention_backend, emit, fail, load_wav, save_wav_f32  # noqa: E402

MODELS = {
    "bs_roformer_sw": {
        "arch": "bs_roformer",
        "config": "bs_roformer_sw.yaml",
        "ckpt": "BS-Roformer-SW.ckpt",
        "label": "6-stem roformer",
    },
    "drumsep": {
        "arch": "mdx23c",
        "config": "drumsep_mdx23c.yaml",
        "ckpt": "MDX23C-DrumSep-aufr33-jarredou.ckpt",
        "label": "drum kit",
        "rename": {"hh": "hihat"},
    },
}

# a 6-stem model keeps these out of "other"; when they were not asked for,
# they are folded back in so "other" matches a 4-stem split
FOLD_INTO_OTHER = ("guitar", "piano")


class Config(dict):
    """dict with attribute access, which the vendored MDX23C code expects"""

    def __getattr__(self, name):
        try:
            value = self[name]
        except KeyError as e:
            raise AttributeError(name) from e
        return Config(value) if isinstance(value, dict) else value


class ConfigLoader(yaml.SafeLoader):
    pass


ConfigLoader.add_constructor(
    "tag:yaml.org,2002:python/tuple",
    lambda loader, node: tuple(loader.construct_sequence(node)),
)


def load_config(name):
    with open(os.path.join(HERE, "configs", name), encoding="utf-8") as f:
        return Config(yaml.load(f, Loader=ConfigLoader))


def build_model(spec, config):
    if spec["arch"] == "bs_roformer":
        from models.bs_roformer.bs_roformer import BSRoformer

        return BSRoformer(**dict(config["model"]))
    if spec["arch"] == "mdx23c":
        from models.mdx23c_tfc_tdf_v3 import TFC_TDF_net

        return TFC_TDF_net(config)
    raise ValueError(f"unknown architecture {spec['arch']}")


def load_model(key, ckpt_dir, device):
    spec = MODELS[key]
    config = load_config(spec["config"])
    path = os.path.join(ckpt_dir, spec["ckpt"])
    if not os.path.exists(path):
        fail(f"the {spec['label']} model is not downloaded ({spec['ckpt']})")
    model = build_model(spec, config)
    state = torch.load(path, map_location="cpu", weights_only=False)
    for wrapper in ("state", "state_dict", "model_state_dict"):
        if isinstance(state, dict) and wrapper in state:
            state = state[wrapper]
    model.load_state_dict(state)
    model.to(device).eval()
    apply_attention_backend(model)
    names = [spec.get("rename", {}).get(n, n) for n in config["training"]["instruments"]]
    return model, config, names


def fade_window(size, fade):
    window = torch.ones(size)
    window[:fade] = torch.linspace(0, 1, fade)
    window[-fade:] = torch.linspace(1, 0, fade)
    return window


def demix(model, config, mix, device, on_progress, overlap):
    """overlapping chunked inference; mix is a (channels, samples) float tensor.
    Returns (stems, channels, samples) on the CPU."""
    chunk = int(config["audio"]["chunk_size"])
    inference = config.get("inference", {}) or {}
    # big batches save little time and multiply VRAM, so cap them
    batch_size = max(1, min(int(inference.get("batch_size", 1)), int(os.environ.get("STEMKIT_BATCH", "2"))))
    use_amp = device == "cuda" and bool(config.get("training", {}).get("use_amp", True))

    step = chunk // overlap
    fade = chunk // 10
    border = chunk - step
    padded = mix.shape[-1] > 2 * border and border > 0
    if padded:
        mix = torch.nn.functional.pad(mix[None], (border, border), mode="reflect")[0]
    total = mix.shape[-1]

    base_window = fade_window(chunk, fade)
    result = None
    counter = torch.zeros(total)
    starts = list(range(0, total, step))

    amp = torch.autocast("cuda", dtype=torch.float16) if use_amp else contextlib.nullcontext()
    with amp:
        for b in range(0, len(starts), batch_size):
            group = starts[b : b + batch_size]
            parts = []
            lengths = []
            for start in group:
                part = mix[:, start : start + chunk]
                seg = part.shape[-1]
                if seg < chunk:
                    mode = "reflect" if seg > chunk // 2 else "constant"
                    part = torch.nn.functional.pad(part[None], (0, chunk - seg), mode=mode)[0]
                parts.append(part)
                lengths.append(seg)
            out = model(torch.stack(parts).to(device))
            if out.dim() == 3:
                out = out[:, None]
            out = out.float().cpu()
            if result is None:
                result = torch.zeros((out.shape[1], mix.shape[0], total))
            for j, (start, seg) in enumerate(zip(group, lengths)):
                window = base_window.clone()
                if start == 0:
                    window[:fade] = 1
                if start + step >= total:
                    window[-fade:] = 1
                window = window[:seg]
                result[..., start : start + seg] += out[j, ..., :seg] * window
                counter[start : start + seg] += window
            on_progress(min(1.0, (group[-1] + step) / total))

    result /= counter.clamp(min=1e-8)
    if padded:
        result = result[..., border:-border]
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--ckpt-dir", required=True)
    parser.add_argument("--model", required=True, choices=sorted(MODELS))
    parser.add_argument("--only", default="", help="comma separated stems to write")
    parser.add_argument("--device", default="auto")
    # twice the chunk overlap, so every moment is predicted from twice as
    # many windows: slower, very slightly cleaner
    parser.add_argument("--second-pass", action="store_true")
    parser.add_argument(
        "--average",
        action="append",
        default=[],
        metavar="STEM=WAV",
        help="average a stem with another model's take on it, e.g. vocals=/path/vocals.wav",
    )
    args = parser.parse_args()

    if args.device == "auto":
        device = "cuda" if torch.cuda.is_available() else "cpu"
    else:
        device = args.device
    if device == "cuda" and not torch.cuda.is_available():
        fail("GPU engine not available (no NVIDIA GPU, or the CUDA build of torch is not installed)")

    audio, sr = load_wav(args.input)
    if sr != 44100:
        fail(f"expected 44.1 kHz audio, got {sr}")
    if audio.shape[0] == 1:
        audio = np.repeat(audio, 2, axis=0)
    mix = torch.from_numpy(np.ascontiguousarray(audio))

    started = time.time()
    last_emit = [0.0]

    def report(frac):
        now = time.time()
        if now - last_emit[0] >= 0.5:
            emit(type="progress", stage="separate", pct=min(99, int(frac * 100)))
            last_emit[0] = now

    label = MODELS[args.model]["label"]
    emit(type="progress", stage="separate", pct=0, message=f"Separating with the {label} model on {device}")

    with torch.inference_mode():
        try:
            model, config, names = load_model(args.model, args.ckpt_dir, device)
            overlap = int((config.get("inference", {}) or {}).get("num_overlap", 2))
            if args.second_pass:
                overlap *= 2
            estimate = demix(model, config, mix, device, report, overlap)
            del model
        except torch.cuda.OutOfMemoryError:
            fail("the GPU ran out of memory; close other GPU apps or run one split at a time")
        except Exception as e:
            fail(f"the {label} model failed: {e}")
        est = {name: estimate[i] for i, name in enumerate(names)}

        wanted = [s.strip() for s in args.only.split(",") if s.strip()] or list(est)
        unknown = [s for s in wanted if s not in est]
        if unknown:
            fail(f"the {label} model does not make: {', '.join(unknown)}")

        stems = {}
        for name in wanted:
            take = est[name]
            if name == "other":
                for extra in FOLD_INTO_OTHER:
                    if extra in est and extra not in wanted:
                        take = take + est[extra]
            stems[name] = take

        for spec in args.average:
            name, _, path = spec.partition("=")
            if name not in stems or not path:
                fail(f"cannot average {spec}")
            take, take_sr = load_wav(path)
            if take_sr != sr:
                fail(f"{path} is {take_sr} Hz, expected {sr}")
            n = min(stems[name].shape[-1], take.shape[-1])
            stems[name] = (stems[name][..., :n] + torch.from_numpy(np.ascontiguousarray(take[:, :n]))) / 2

        os.makedirs(args.out, exist_ok=True)
        for name, data in stems.items():
            if torch.isnan(data).any():
                fail(f"separation produced invalid audio for {name}")
            save_wav_f32(os.path.join(args.out, f"{name}.wav"), data.numpy(), sr)
            emit(type="stem", name=name)

    emit(type="done", stems=list(stems), out_dir=args.out, seconds=round(time.time() - started, 1))


if __name__ == "__main__":
    main()
