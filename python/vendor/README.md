# Vendored model code

Model definitions from
[Music-Source-Separation-Training](https://github.com/ZFTurbo/Music-Source-Separation-Training)
(MIT, see `models/LICENSE-MSST`), which builds on lucidrains' BS-RoFormer implementation (MIT).

## Mel-band roformer (`models/bs_roformer/mel_band_roformer.py`, `attend.py`)

Used by `roformer.py` for studio vocals. Patches applied for Apple Silicon (MPS) inference:

- complex mask math is done in real/imag components, because MPS does not
  support complex `scatter_add_` (mel-band variant) or reliable complex multiply
- `torch.istft` is replaced with a manual overlap-add (it depends on
  `aten::unfold_backward`, which is not implemented on MPS)
- the STFT and band-split run in fp32 (fp16 accumulation overflows on loud
  material); the attention stack runs in fp16 for speed
- the mel filter bank is precomputed (`mel_bank_44100_2048_60.npy`) so librosa
  is not a runtime dependency

## Web version additions

Copied unmodified from MSST commit `050cae7`, used by `msst.py`:

- `models/bs_roformer/bs_roformer.py`: BS-Roformer, for the 6-stem BS-Roformer SW model
- `models/mdx23c_tfc_tdf_v3.py`: MDX23C, for the drum kit split. The one change
  inlines `prefer_target_instrument` so the file does not need MSST's `utils` package

Their configs live in `python/configs`.
