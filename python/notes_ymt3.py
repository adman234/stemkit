"""Note transcription with YourMT3+.

The slower, stronger alternative to notes.py: YourMT3+ (Chang, Benetos,
Kirchhoff and Dixon, MLSP 2024) is a multi-instrument transcription model
trained on ten datasets including GuitarSet. This runs the YPTF.MoE+Multi
(noPS) checkpoint, the one its demo uses, on one stem and writes the same
JSON as notes.py, so the player shows either the same way.

The model code is not bundled: on first use it is fetched from the
authors' Hugging Face Space (Apache 2.0) at a fixed revision into the
models folder, next to the checkpoint, which the server downloads. Progress
is printed as JSON lines like the other scripts.
"""

import argparse
import json
import os
import sys
import time
import types
import urllib.request
import warnings

import numpy as np

warnings.filterwarnings("ignore")

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from wavio import read_any  # noqa: E402

CHECKPOINT = "yourmt3-yptf-moe-multi-nops.ckpt"
MODEL_LABEL = "YourMT3+ (YPTF.MoE+Multi)"

# the authors' Space, pinned so an update there cannot change what runs here
SPACE = "https://huggingface.co/spaces/mimbres/YourMT3/resolve/5e66c1ea173a8186e0d20432b841d3180cc015b5/amt/src/"
SOURCE_DIR = "yourmt3-src-5e66c1e"
SOURCE_FILES = """
config/config.py config/data_presets.py config/task.py config/vocabulary.py
model/RoPE/RoPE.py model/conformer_helper.py model/conformer_mod.py model/conv_block.py
model/ff_layer.py model/init_train.py model/lm_head.py model/lr_scheduler.py model/ops.py
model/optimizers.py model/perceiver_helper.py model/perceiver_mod.py model/pitchshift_layer.py
model/positional_encoding.py model/projection_layer.py model/spectrogram.py model/t5mod.py
model/t5mod_helper.py model/ymt3.py utils/audio.py utils/augment.py utils/data_modules.py
utils/datasets_eval.py utils/datasets_helper.py utils/datasets_train.py utils/event2note.py
utils/event_codec.py utils/metrics.py utils/metrics_helper.py utils/midi.py utils/note2event.py
utils/note_event_dataclasses.py utils/task_manager.py utils/tokenizer.py utils/utils.py
""".split()

# the settings the demo loads this checkpoint with (its app.py), with every
# other option at its default
MODEL_ARGS = {
    "project": "2024", "audio_codec": "spec", "hop_length": 300, "n_mels": None,
    "input_frames": None, "sca_use_query_residual": True, "encoder_type": "perceiver-tf",
    "decoder_type": "multi-t5", "pre_encoder_type": "default", "pre_decoder_type": "default",
    "conv_out_channels": None, "task_cond_encoder": True, "task_cond_decoder": True,
    "d_feat": None, "pretrained": False, "base_name": "google/t5-v1_1-small",
    "encoder_position_encoding_type": "rope", "decoder_position_encoding_type": "default",
    "tie_word_embedding": None, "event_length": None, "d_latent": None, "num_latents": 26,
    "perceiver_tf_d_model": None, "num_perceiver_tf_blocks": None,
    "num_perceiver_tf_local_transformers_per_block": None,
    "num_perceiver_tf_temporal_transformers_per_block": None, "attention_to_channel": True,
    "layer_norm_type": None, "ff_layer_type": "moe", "ff_widening_factor": 4,
    "moe_num_experts": 8, "moe_topk": 2, "hidden_act": "silu", "rotary_type": None,
    "rope_apply_to_keys": None, "rope_partial_pe": True, "decoder_ff_layer_type": None,
    "decoder_ff_widening_factor": None, "task": "mc13_full_plus_256",
    "eval_program_vocab": None, "eval_drum_vocab": None, "eval_subtask_key": "default",
    "onset_tolerance": 0.05, "test_octave_shift": False, "write_model_output": False,
    "precision": "32", "strategy": "auto", "num_nodes": 1, "num_gpus": "auto",
    "wandb_mode": "disabled", "debug_mode": False, "test_pitch_shift": None, "epochs": None,
}

# same per-stem pitch ranges as notes.py, in MIDI note numbers
RANGES = {"guitar": (35, 89), "bass": (21, 67), "vocals": (37, 89)}


def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)


def fail(message):
    emit(type="error", message=str(message))
    sys.exit(1)


def fetch_source(models_dir):
    """the model code, downloaded once into the models folder"""
    root = os.path.join(models_dir, SOURCE_DIR)
    marker = os.path.join(root, ".complete")
    if os.path.exists(marker):
        return root
    emit(type="progress", stage="separate", pct=0, message="Downloading the YourMT3 code (one time)")
    for name in SOURCE_FILES:
        dest = os.path.join(root, *name.split("/"))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        req = urllib.request.Request(SPACE + name, headers={"User-Agent": "StemKit"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read()
        with open(dest, "wb") as f:
            f.write(data)
    open(marker, "w").close()
    return root


def load_model(models_dir, device):
    import torch

    src = fetch_source(models_dir)
    sys.path.insert(0, src)
    # imported by the training code only; a stand-in whose every name is an
    # empty class keeps the large package out
    stub = types.ModuleType("wandb")

    def stand_in(name):
        if name.startswith("_"):
            raise AttributeError(name)
        return type(name, (), {"__init__": lambda self, *a, **k: None})

    stub.__getattr__ = stand_in
    sys.modules.setdefault("wandb", stub)

    from model.init_train import update_config
    from model.ymt3 import YourMT3
    from utils.task_manager import TaskManager
    from config.config import shared_cfg as default_shared_cfg
    from copy import deepcopy

    args = argparse.Namespace(**MODEL_ARGS)
    shared_cfg, audio_cfg, model_cfg = update_config(args, deepcopy(default_shared_cfg), stage="test")
    tm = TaskManager(
        task_name=args.task,
        max_shift_steps=int(shared_cfg["TOKENIZER"]["max_shift_steps"]),
        debug_mode=False,
    )
    # the constructor prints its settings; stdout is for progress lines
    import contextlib

    with contextlib.redirect_stdout(sys.stderr):
        model = YourMT3(
            audio_cfg=audio_cfg,
            model_cfg=model_cfg,
            shared_cfg=shared_cfg,
            optimizer=None,
            task_manager=tm,
            eval_subtask_key=args.eval_subtask_key,
            write_output_dir=None,
        )
    ckpt = torch.load(os.path.join(models_dir, CHECKPOINT), map_location="cpu", weights_only=False)
    state = {k: v for k, v in ckpt["state_dict"].items() if "pitchshift" not in k}
    model.load_state_dict(state, strict=False)
    del ckpt
    return model.to(device).eval()


def transcribe(model, audio, sr, on_progress):
    import torch
    import torchaudio
    from utils.audio import slice_padded_array
    from utils.note2event import mix_notes
    from utils.event2note import merge_zipped_note_events_and_ties_to_notes

    target = model.audio_cfg["sample_rate"]
    wav = torch.from_numpy(audio.mean(axis=0, keepdims=True).astype(np.float32))
    wav = torchaudio.functional.resample(wav, sr, target)
    frames = model.audio_cfg["input_frames"]
    segments = slice_padded_array(wav.numpy(), frames, frames)
    segments = torch.from_numpy(segments.astype("float32")).unsqueeze(1)
    n = segments.shape[0]

    # batches by hand, so progress can be reported between them
    batch = 8
    tokens = []
    with torch.inference_mode():
        for i in range(0, n, batch):
            part, _ = model.inference_file(bsz=batch, audio_segments=segments[i : i + batch].to(model.device))
            tokens.extend(part)
            on_progress(min(1.0, (i + batch) / n))

    starts = [frames * i / target for i in range(n)]
    channels = []
    for ch in range(model.task_manager.num_decoding_channels):
        per_ch = [arr[:, ch, :] for arr in tokens]
        zipped, _, _ = model.task_manager.detokenize_list_batches(per_ch, starts, return_events=True)
        notes, _ = merge_zipped_note_events_and_ties_to_notes(zipped)
        channels.append(notes)
    return mix_notes(channels), n * frames / target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="the stem to transcribe")
    parser.add_argument("--out", required=True, help="where to write the JSON")
    parser.add_argument("--ckpt-dir", required=True)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--stem", default="", help="which stem it is; sets the pitch range")
    parser.add_argument("--source", default="", help="what the input was, for the JSON")
    args = parser.parse_args()

    started = time.time()
    emit(type="progress", stage="separate", pct=0, message="Loading YourMT3+")
    try:
        import torch

        device = args.device if args.device == "cpu" or torch.cuda.is_available() else "cpu"
        model = load_model(args.ckpt_dir, device)
    except Exception as err:  # noqa: BLE001
        fail(f"could not load YourMT3+: {err}")

    audio, sr = read_any(args.input)
    duration = audio.shape[1] / sr
    if duration < 0.5:
        fail("the audio is too short to transcribe")

    emit(type="progress", stage="separate", pct=5, message="Listening for notes")
    last = [0.0]

    def report(frac):
        now = time.time()
        if now - last[0] >= 0.5:
            emit(type="progress", stage="separate", pct=5 + int(frac * 90))
            last[0] = now

    notes, _ = transcribe(model, audio, sr, report)
    emit(type="progress", stage="separate", pct=96, message="Reading the notes out")

    low, high = RANGES.get(args.stem, (0, 127))
    events = []
    for note in notes:
        if note.is_drum or not (low <= note.pitch <= high):
            continue
        end = max(float(note.offset), float(note.onset) + 0.03)
        if note.onset >= duration:
            continue
        events.append(
            {
                "start": round(float(note.onset), 3),
                "end": round(min(end, duration), 3),
                "pitch": int(note.pitch),
                # the model marks notes on or off, not how hard they are played
                "velocity": 96,
            }
        )
    events.sort(key=lambda e: (e["start"], e["pitch"]))

    result = {
        "stem": args.stem,
        "notes": events,
        "duration": round(duration, 3),
        "source": args.source,
        "model": MODEL_LABEL,
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, separators=(",", ":"))

    emit(type="done", notes=len(events), seconds=round(time.time() - started, 1), device=device)


if __name__ == "__main__":
    main()
