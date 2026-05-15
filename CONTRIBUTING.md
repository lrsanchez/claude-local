# Contributing

This is a small, opinionated repo built around the specific Strix Halo + Bazzite
+ Claude Code workflow. PRs are welcome if they fit that scope.

## Easy wins

- **Additional hardware coverage**: working setups for Framework Desktop, EVO-X2,
  other Strix Halo machines. Add a new doc in `docs/` following the existing
  format.
- **Tested model swaps**: if you find a better-performing model for Strix Halo
  with verified `-c`, `-fa`, sampling-params combos, document it. Drop a doc
  or update the existing ones with a "Tested models" table.
- **Troubleshooting entries**: if you hit a new failure mode and figure out the
  fix, add it to the relevant `docs/*-BAZZITE.md` troubleshooting table.
- **`claude-smart` improvements**: better health probes, tiered fallback logic
  (Anthropic → remote PX13 → local), better error messages.

## Not in scope

- General LLM tooling unrelated to Claude Code
- Non-Strix-Halo AMD GPUs (different driver story)
- Non-Bazzite Linux distros (Ubuntu users should reference Pablo's repo)
- Windows / macOS variants

## Style

- Bash scripts use `set -uo pipefail` (or `-euo pipefail` where appropriate)
- Markdown uses ATX headings (`#`, `##`) and fenced code blocks with language tags
- systemd units are kept minimal — no NICE, IOSchedule, etc. unless required
- Document the "why" alongside the "what" — this repo is partly a knowledge base

## Provenance

If you carry over working configs from upstream sources, credit them in the
README's "Credits" section. The big ones:

- kyuz0/amd-strix-halo-toolboxes
- pablo-ross/strix-halo-gmktec-evo-x2
- ggml-org/llama.cpp
- LM Studio Community / Bartowski / Unsloth GGUF providers

Don't claim novelty where it doesn't apply — this repo's value is in the
synthesis and the lessons-learned section, not in the underlying tooling.
