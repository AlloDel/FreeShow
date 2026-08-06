# Whisper vs Nemotron — evaluation notes (archived)

**Product decision (2026-08):** FreeShow Auto-Bible ships **Nemotron only**.
Whisper (sherpa offline Turbo and whisper.cpp binaries) is **not** offered in Settings.
It does not match short-command / streaming-partial latency needs; Rhema/PewBeam used
Whisper for historical / sermon-window reasons, not because it beats transducers here.

Nemotron streaming (`nemotron-en-int8`) is the sole catalog model.

Optional Whisper paths remain in git history if a future “transcript accuracy mode”
is revisited (e.g. Live Notes long-form). Do not re-add to the catalog without a
fresh side-by-side eval against Nemotron on short refs + quote recall.
