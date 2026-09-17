"""WAV reading shared by the separation scripts.

The stdlib wave module only reads integer PCM, but stems are written as
32-bit float WAVs, and later steps (the drum kit split, instrument models
running on the vocal-free instrumental) read those back in.
"""

import struct

import numpy as np

PCM = 1
FLOAT = 3
EXTENSIBLE = 0xFFFE


def read_wav(path):
    """returns (audio, sample_rate) with audio as (channels, samples) float32"""
    with open(path, "rb") as f:
        data = f.read()
    if len(data) < 12 or data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        raise ValueError("not a RIFF/WAVE file")
    fmt = None
    payload = None
    pos = 12
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        size = struct.unpack_from("<I", data, pos + 4)[0]
        body = pos + 8
        if chunk_id == b"fmt ":
            tag, channels, rate, _, _, bits = struct.unpack_from("<HHIIHH", data, body)
            if tag == EXTENSIBLE and size >= 26:
                tag = struct.unpack_from("<H", data, body + 24)[0]
            fmt = (tag, channels, rate, bits)
        elif chunk_id == b"data":
            payload = data[body : min(len(data), body + size)]
        pos = body + size + (size & 1)
    if fmt is None or payload is None:
        raise ValueError("missing fmt or data chunk")
    tag, channels, rate, bits = fmt
    if channels == 0:
        raise ValueError("no channels")
    if tag == PCM and bits == 16:
        audio = np.frombuffer(payload[: len(payload) // 2 * 2], dtype="<i2").astype(np.float32) / 32768.0
    elif tag == FLOAT and bits == 32:
        audio = np.frombuffer(payload[: len(payload) // 4 * 4], dtype="<f4").astype(np.float32)
    else:
        raise ValueError(f"unsupported WAV encoding (format {tag}, {bits} bit)")
    frames = audio.shape[0] // channels
    return audio[: frames * channels].reshape(frames, channels).T, rate
