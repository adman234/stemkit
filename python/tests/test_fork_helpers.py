"""The fork's own python helpers that need nothing beyond numpy: WAV reading
(wavio.py), the lyrics aligner's text handling and CTC alignment
(lyrics_align.py), and Basic Pitch's pitch conversion (notes.py). Model code
needs torch or onnxruntime and is covered by the docker smoke test instead."""

import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path

import numpy as np

PYTHON_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PYTHON_DIR))

import lyrics_align as la  # noqa: E402
import notes  # noqa: E402
from wavio import read_wav  # noqa: E402


def float_wav(path, audio, rate, extensible=False):
    """a 32-bit float WAV, (channels, samples) in, written by hand since the
    stdlib wave module only writes integer PCM"""
    channels = audio.shape[0]
    payload = audio.T.astype("<f4").tobytes()
    if extensible:
        fmt = struct.pack("<HHIIHHHHI", 0xFFFE, channels, rate, rate * channels * 4, channels * 4, 32, 22, 32, 0)
        fmt += struct.pack("<H", 3) + b"\x00" * 14
    else:
        fmt = struct.pack("<HHIIHH", 3, channels, rate, rate * channels * 4, channels * 4, 32)
    # an odd-sized chunk before the audio, to check the padding byte is skipped
    extra = b"LIST" + struct.pack("<I", 3) + b"abc\x00"
    body = b"WAVE" + b"fmt " + struct.pack("<I", len(fmt)) + fmt + extra + b"data" + struct.pack("<I", len(payload)) + payload
    Path(path).write_bytes(b"RIFF" + struct.pack("<I", len(body)) + body)


class WavioTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def path(self, name):
        return str(Path(self.dir.name) / name)

    def test_float_wav_round_trips_exactly(self):
        audio = np.array([[0.0, 0.5, -0.25, 1.5], [0.1, -0.1, 0.2, -2.0]], dtype=np.float32)
        for extensible in (False, True):
            p = self.path(f"f{extensible}.wav")
            float_wav(p, audio, 48000, extensible)
            got, rate = read_wav(p)
            self.assertEqual(rate, 48000)
            self.assertEqual(got.shape, (2, 4))
            np.testing.assert_array_equal(got, audio)

    def test_int16_wav_is_scaled_to_float(self):
        p = self.path("i16.wav")
        with wave.open(p, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(44100)
            w.writeframes(np.array([0, 16384, -32768], dtype="<i2").tobytes())
        got, rate = read_wav(p)
        self.assertEqual(rate, 44100)
        np.testing.assert_allclose(got, [[0.0, 0.5, -1.0]])

    def test_bad_files_raise(self):
        p = self.path("bad.wav")
        Path(p).write_bytes(b"not a wav at all")
        with self.assertRaises(ValueError):
            read_wav(p)
        with wave.open(p, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(1)
            w.setframerate(8000)
            w.writeframes(b"\x80\x80")
        with self.assertRaisesRegex(ValueError, "unsupported"):
            read_wav(p)


class LyricsTextTest(unittest.TestCase):
    def test_parse_lrc_orders_lines_and_expands_repeated_times(self):
        lrc = "[ar:Someone]\n[00:12.50]second\n[00:01.00][01:02]chorus\nno time here\n"
        self.assertEqual(la.parse_lrc(lrc), [(1.0, "chorus"), (12.5, "second"), (62.0, "chorus")])

    def test_letters_drops_accents_and_symbols(self):
        self.assertEqual(la.letters("Café"), "CAFE")
        self.assertEqual(la.letters("don’t!"), "DON'T")
        self.assertEqual(la.letters("'quoted'"), "QUOTED")
        self.assertEqual(la.letters("123"), "")

    def test_tokens_for_marks_word_spans_and_skips_unspellable_words(self):
        tokens, spans = la.tokens_for(["hi", "42", "yo"])
        v = la.VOCAB
        self.assertEqual(tokens, [v["H"], v["I"], la.SPACE, v["Y"], v["O"]])
        self.assertEqual(spans, [(0, 1), None, (3, 4)])

    def test_spread_lays_words_out_by_length(self):
        out = la.spread(["a", "bbb"], 10.0, 14.0)
        self.assertEqual([w["text"] for w in out], ["a", "bbb"])
        self.assertEqual((out[0]["start"], out[0]["end"]), (10.0, 11.0))
        self.assertEqual((out[1]["start"], out[1]["end"]), (11.0, 14.0))


class ForceAlignTest(unittest.TestCase):
    def emissions(self, frames, heard):
        """log-probabilities where only blank is likely, except the given
        token on the given frame"""
        em = np.full((frames, len(la.VOCAB)), -20.0, dtype=np.float32)
        em[:, la.BLANK] = 0.0
        for t, token in heard.items():
            em[t, la.BLANK] = -20.0
            em[t, token] = 0.0
        return em

    def test_tokens_land_on_the_frames_they_are_heard(self):
        a, b = la.VOCAB["A"], la.VOCAB["B"]
        frames, score = la.force_align(self.emissions(10, {3: a, 7: b}), [a, b])
        self.assertEqual(list(frames), [3, 7])
        self.assertAlmostEqual(score, 0.0)

    def test_too_short_a_stretch_cannot_hold_the_tokens(self):
        a = la.VOCAB["A"]
        self.assertEqual(la.force_align(self.emissions(1, {}), [a, a]), (None, None))
        self.assertEqual(la.force_align(self.emissions(5, {}), []), (None, None))

    def test_place_words_fills_unspellable_words_between_neighbours(self):
        out = la.place_words(["hi", "42", "yo"], [(0, 1), None, (3, 4)], np.array([0, 5, 6, 20, 25]), 1.0, 5.0)
        self.assertEqual([w["text"] for w in out], ["hi", "42", "yo"])
        self.assertAlmostEqual(out[0]["start"], 1.0)
        self.assertAlmostEqual(out[2]["start"], 1.0 + 20 * la.FRAME)
        self.assertGreaterEqual(out[1]["start"], out[0]["start"])
        self.assertLessEqual(out[1]["start"], out[2]["start"])
        for w in out:
            self.assertGreater(w["end"], w["start"])


class NotesTest(unittest.TestCase):
    def test_hz_to_midi(self):
        self.assertAlmostEqual(float(notes.hz_to_midi(440.0)), 69.0)
        self.assertAlmostEqual(float(notes.hz_to_midi(880.0)), 81.0)
        self.assertAlmostEqual(float(notes.hz_to_midi(261.6256)), 60.0, places=3)

    def test_frame_times_rise_steadily(self):
        times = notes.frames_to_time(2000)
        self.assertEqual(times[0], 0.0)
        self.assertTrue(np.all(np.diff(times) > 0))


if __name__ == "__main__":
    unittest.main()
