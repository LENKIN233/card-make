# Kokoro generation sources

The current candidate recordings were synthesized locally from the card transcripts using Kokoro-82M. The model publisher declares its weights under Apache-2.0. This notice identifies the generation tools and model; it does not assign a new license to the card text or replace content authorization and exact-asset audio acceptance.

- Original model: [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M).
- MLX conversion: [mlx-community/Kokoro-82M-bf16 at a71e4d38b236d968966a2002c4c895dbd12b1c3c](https://huggingface.co/mlx-community/Kokoro-82M-bf16/tree/a71e4d38b236d968966a2002c4c895dbd12b1c3c).
- Model license: [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0).
- Voice documentation and upstream attribution: [Kokoro voices](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md), [model card](https://huggingface.co/hexgrad/Kokoro-82M).

The model card credits StyleTTS2's authors and describes its training sources, including Koniwa and SIWIS. See the upstream card for those attributions. Model weights and generation dependencies are not distributed in this repository.

`kokoro-20260920.json` records the pinned model and voice file hashes, exact text, voice, seed, speed, output bytes, mastering parameters and measured durations for each candidate. Raw generation and technical checks do not establish perceptual acceptance. The formal record belongs under `reviews/audio_qc/` after complete model consumption and trusted receipt verification.
