# Whisper vs Nemotron — evaluation notes

**Never default to Whisper.** Nemotron streaming (`nemotron-en-int8`) remains the recommended
default for Bible auto-show (short refs, next/previous, low latency).

Optional model: `whisper-large-v3-turbo-int8` from
[`soniqo/Whisper-Large-v3-Turbo-ONNX`](https://huggingface.co/soniqo/Whisper-Large-v3-Turbo-ONNX)
(`turbo-encoder.int8.onnx`, `turbo-decoder.int8.onnx`, `turbo-tokens.txt`, ~1 GB).

## Before recommending Whisper

Compare both models on the golden fixtures in `fixtures.ts` / live sermon captures:

1. Short spoken refs (`John 3:16`, `verse 12`, `next verse`) — Nemotron should stay better (streaming partials).
2. Long quoted verse text without a reference — Whisper may win on WER; measure quote-matcher hits.
3. Latency to first usable partial / final — Whisper is utterance-based (no partials); note UX cost.
4. RAM / CPU on target hardware — Whisper needs substantially more memory.

Only switch the product default after fixture scores clearly favor Whisper on quote recall *without*
hurting short-command precision. Until then, keep Whisper optional in Settings with the RAM warning.
