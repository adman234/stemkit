"""Note transcription.

Reads one stem, runs Spotify's Basic Pitch model over it (the ONNX export,
on the CPU: the model is about 230 KB and a few minutes of audio take
seconds) and writes a JSON file with the notes. Progress is printed as JSON
lines like the other scripts.

The windowing, the note decoding and the pitch bend estimate follow
basic_pitch/inference.py and basic_pitch/note_creation.py from
https://github.com/spotify/basic-pitch (v0.4.0, Apache 2.0), trimmed to
what is used here so the package and its dependencies are not needed.
"""

import argparse
import json
import os
import sys
import time
import warnings

import numpy as np

warnings.filterwarnings("ignore", category=UserWarning)
warnings.filterwarnings("ignore", category=FutureWarning)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from wavio import read_any  # noqa: E402

MODEL_NAME = "basic-pitch-icassp2022.onnx"

# Basic Pitch constants (basic_pitch/constants.py)
FFT_HOP = 256
SAMPLE_RATE = 22050
FPS = SAMPLE_RATE // FFT_HOP  # 86 model frames per second
WINDOW_SECONDS = 2
ANNOT_N_FRAMES = FPS * WINDOW_SECONDS
N_SAMPLES = SAMPLE_RATE * WINDOW_SECONDS - FFT_HOP
BASE_FREQUENCY = 27.5  # A0, the lowest pitch the model knows
CONTOUR_BINS_PER_SEMITONE = 3
N_CONTOUR_BINS = 88 * CONTOUR_BINS_PER_SEMITONE
MIDI_OFFSET = 21
MAX_FREQ_IDX = 87
# windows overlap by 30 frames; half of that is cut from each side
OVERLAP_FRAMES = 30
OVERLAP_SAMPLES = OVERLAP_FRAMES * FFT_HOP
HOP_SAMPLES = N_SAMPLES - OVERLAP_SAMPLES
WINDOWS_PER_BATCH = 16

# Basic Pitch's defaults
ONSET_THRESHOLD = 0.5
FRAME_THRESHOLD = 0.3
MIN_NOTE_MS = 127.70
ENERGY_TOLERANCE = 11

# Pitch range kept per stem, in Hz. A guitar in drop C reaches about 65 Hz
# and the 24th fret on the top string is 1319 Hz; anything outside is bleed
# or a harmonic. None keeps the model's full range
RANGES = {
    "guitar": (60.0, 1400.0),
    "bass": (28.0, 400.0),
    "vocals": (70.0, 1400.0),
}


# same as roformer.py's, kept here so this script does not have to load torch
def emit(**kwargs):
    print(json.dumps(kwargs), flush=True)


def fail(message):
    emit(type="error", message=str(message))
    sys.exit(1)


def read_mono(path):
    """the stem as mono float32 at the model's sample rate"""
    from math import gcd

    from scipy.signal import resample_poly

    try:
        audio, sr = read_any(path)
    except Exception as e:
        fail(f"cannot read audio {path}: {e}")
    mono = np.asarray(audio, dtype=np.float32).mean(axis=0)
    if sr != SAMPLE_RATE:
        g = gcd(int(sr), SAMPLE_RATE)
        mono = resample_poly(mono, SAMPLE_RATE // g, int(sr) // g)
    return np.ascontiguousarray(mono, dtype=np.float32)


def load_session(ckpt_dir):
    import onnxruntime as ort

    path = os.path.join(ckpt_dir, MODEL_NAME)
    if not os.path.exists(path):
        fail(f"the note model is not downloaded ({MODEL_NAME})")
    options = ort.SessionOptions()
    options.log_severity_level = 3
    return ort.InferenceSession(path, sess_options=options, providers=["CPUExecutionProvider"])


def run_model(session, audio, on_progress):
    """note, onset and contour activations, one row per model frame"""
    original_length = len(audio)
    padded = np.concatenate([np.zeros(OVERLAP_SAMPLES // 2, dtype=np.float32), audio])
    windows = []
    for i in range(0, len(padded), HOP_SAMPLES):
        window = padded[i : i + N_SAMPLES]
        if len(window) < N_SAMPLES:
            window = np.pad(window, (0, N_SAMPLES - len(window)))
        windows.append(window)

    outputs = {"note": [], "onset": [], "contour": []}
    names = ["StatefulPartitionedCall:1", "StatefulPartitionedCall:2", "StatefulPartitionedCall:0"]
    input_name = session.get_inputs()[0].name
    for start in range(0, len(windows), WINDOWS_PER_BATCH):
        batch = np.stack(windows[start : start + WINDOWS_PER_BATCH])[:, :, None]
        note, onset, contour = session.run(names, {input_name: batch})
        outputs["note"].append(note)
        outputs["onset"].append(onset)
        outputs["contour"].append(contour)
        on_progress(min(start + WINDOWS_PER_BATCH, len(windows)) / len(windows))

    n_frames = int(np.floor(original_length * (FPS / SAMPLE_RATE)))
    half = OVERLAP_FRAMES // 2
    unwrapped = {}
    for key, parts in outputs.items():
        stacked = np.concatenate(parts)[:, half:-half, :]
        unwrapped[key] = stacked.reshape(-1, stacked.shape[2])[:n_frames]
    return unwrapped


def hz_to_midi(hz):
    return 12.0 * np.log2(hz / 440.0) + 69.0


def midi_to_contour_bin(pitch):
    hz = 440.0 * 2.0 ** ((pitch - 69.0) / 12.0)
    return 12.0 * CONTOUR_BINS_PER_SEMITONE * np.log2(hz / BASE_FREQUENCY)


def frames_to_time(n_frames):
    """model frame index to seconds, with Basic Pitch's per-window correction"""
    original = np.arange(n_frames) * FFT_HOP / SAMPLE_RATE
    window_numbers = np.floor(np.arange(n_frames) / ANNOT_N_FRAMES)
    window_offset = (FFT_HOP / SAMPLE_RATE) * (ANNOT_N_FRAMES - (N_SAMPLES / FFT_HOP)) + 0.0018
    return original - window_offset * window_numbers


def inferred_onsets(onsets, frames, n_diff=2):
    """adds onsets where a note's frame activation jumps"""
    diffs = []
    for n in range(1, n_diff + 1):
        shifted = np.concatenate([np.zeros((n, frames.shape[1])), frames])
        diffs.append(shifted[n:, :] - shifted[:-n, :])
    frame_diff = np.min(diffs, axis=0)
    frame_diff[frame_diff < 0] = 0
    frame_diff[:n_diff, :] = 0
    peak = np.max(frame_diff)
    if peak > 0:
        frame_diff = np.max(onsets) * frame_diff / peak
    return np.max([onsets, frame_diff], axis=0)


def decode_notes(frames, onsets, min_freq, max_freq):
    """(start frame, end frame, midi pitch, amplitude) per note"""
    import scipy.signal

    frames = frames.copy()
    onsets = onsets.copy()
    n_frames = frames.shape[0]
    min_note_len = int(np.round(MIN_NOTE_MS / 1000 * (SAMPLE_RATE / FFT_HOP)))

    if max_freq is not None:
        idx = int(np.round(hz_to_midi(max_freq) - MIDI_OFFSET))
        onsets[:, idx:] = 0
        frames[:, idx:] = 0
    if min_freq is not None:
        idx = int(np.round(hz_to_midi(min_freq) - MIDI_OFFSET))
        onsets[:, :idx] = 0
        frames[:, :idx] = 0

    onsets = inferred_onsets(onsets, frames)
    peaks = np.zeros(onsets.shape)
    where = scipy.signal.argrelmax(onsets, axis=0)
    peaks[where] = onsets[where]
    onset_time, onset_freq = np.where(peaks >= ONSET_THRESHOLD)

    remaining = frames.copy()
    notes = []
    # latest onsets first, so a repeated note does not swallow the next one
    for start, freq in zip(onset_time[::-1], onset_freq[::-1]):
        if start >= n_frames - 1:
            continue
        i = start + 1
        k = 0
        while i < n_frames - 1 and k < ENERGY_TOLERANCE:
            k = k + 1 if remaining[i, freq] < FRAME_THRESHOLD else 0
            i += 1
        i -= k
        if i - start <= min_note_len:
            continue
        remaining[start:i, freq] = 0
        if freq < MAX_FREQ_IDX:
            remaining[start:i, freq + 1] = 0
        if freq > 0:
            remaining[start:i, freq - 1] = 0
        notes.append((int(start), int(i), int(freq + MIDI_OFFSET), float(np.mean(frames[start:i, freq]))))

    # the "melodia trick": notes that sustain without a clear onset
    while np.max(remaining) > FRAME_THRESHOLD:
        mid, freq = np.unravel_index(np.argmax(remaining), remaining.shape)
        remaining[mid, freq] = 0

        i = mid + 1
        k = 0
        while i < n_frames - 1 and k < ENERGY_TOLERANCE:
            k = k + 1 if remaining[i, freq] < FRAME_THRESHOLD else 0
            remaining[i, freq] = 0
            if freq < MAX_FREQ_IDX:
                remaining[i, freq + 1] = 0
            if freq > 0:
                remaining[i, freq - 1] = 0
            i += 1
        end = i - 1 - k

        i = mid - 1
        k = 0
        while i > 0 and k < ENERGY_TOLERANCE:
            k = k + 1 if remaining[i, freq] < FRAME_THRESHOLD else 0
            remaining[i, freq] = 0
            if freq < MAX_FREQ_IDX:
                remaining[i, freq + 1] = 0
            if freq > 0:
                remaining[i, freq - 1] = 0
            i -= 1
        start = i + 1 + k

        if end - start <= min_note_len:
            continue
        notes.append((int(start), int(end), int(freq + MIDI_OFFSET), float(np.mean(frames[start:end, freq]))))

    return notes


def pitch_bends(contours, notes, tolerance=25):
    """per note, the bend in thirds of a semitone at each model frame"""
    import scipy.signal
    from scipy.ndimage import median_filter

    length = tolerance * 2 + 1
    gaussian = scipy.signal.windows.gaussian(length, std=5)
    out = []
    for start, end, pitch, _ in notes:
        idx = int(np.round(midi_to_contour_bin(pitch)))
        lo = max(idx - tolerance, 0)
        hi = min(N_CONTOUR_BINS, idx + tolerance + 1)
        weights = gaussian[max(0, tolerance - idx) : length - max(0, idx - (N_CONTOUR_BINS - tolerance - 1))]
        shift = tolerance - max(0, tolerance - idx)
        sub = contours[start:end, lo:hi] * weights
        raw = np.argmax(sub, axis=1) - shift
        # the contour jumps for a frame or two where the next note starts;
        # a short median keeps real bends and drops those
        out.append(median_filter(raw, size=5, mode="mirror").astype(int) if raw.size else raw)
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="the stem to transcribe")
    parser.add_argument("--out", required=True, help="where to write the JSON")
    parser.add_argument("--ckpt-dir", required=True)
    parser.add_argument("--stem", default="", help="which stem it is; sets the pitch range")
    parser.add_argument("--source", default="", help="what the input was, for the JSON")
    args = parser.parse_args()

    started = time.time()
    emit(type="progress", stage="separate", pct=0, message="Listening for notes")
    audio = read_mono(args.input)
    duration = len(audio) / SAMPLE_RATE
    if duration < 0.5:
        fail("the audio is too short to transcribe")
    session = load_session(args.ckpt_dir)
    last = [0.0]

    def report(frac):
        now = time.time()
        if now - last[0] >= 0.5:
            # the model is most of the time; decoding takes the last stretch
            emit(type="progress", stage="separate", pct=min(90, int(frac * 90)))
            last[0] = now

    output = run_model(session, audio, report)
    emit(type="progress", stage="separate", pct=92, message="Reading the notes out")
    min_freq, max_freq = RANGES.get(args.stem, (None, None))
    notes = decode_notes(output["note"], output["onset"], min_freq, max_freq)
    bends = pitch_bends(output["contour"], notes)
    times = frames_to_time(output["contour"].shape[0])

    events = []
    for (start, end, pitch, amplitude), bend in zip(notes, bends):
        event = {
            "start": round(float(times[start]), 3),
            "end": round(float(times[end]), 3),
            "pitch": pitch,
            "velocity": int(np.clip(np.round(127 * amplitude), 1, 127)),
        }
        # a bend is worth keeping once it moves at least two thirds of a
        # semitone; smaller wobbles are vibrato or noise in the contour
        if bend.size and np.max(np.abs(bend)) >= 2:
            event["bend"] = [int(b) for b in bend]
        events.append(event)
    events.sort(key=lambda e: (e["start"], e["pitch"]))

    result = {
        "stem": args.stem,
        "notes": events,
        # bends are in thirds of a semitone, spread evenly from start to end
        "duration": round(duration, 3),
        "source": args.source,
        "model": "Basic Pitch (Spotify)",
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(result, f, separators=(",", ":"))

    emit(type="done", notes=len(events), seconds=round(time.time() - started, 1))


if __name__ == "__main__":
    main()
