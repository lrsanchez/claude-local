# TODO for Claude Code: Update claude-local repo with FINAL Duo findings

You are working in the `claude-local` repo at
`/var/home/leandro/Documents/dev/personal/claude-local`. The user spent a
very long session today figuring out the actual working setup for the
Zenbook Duo. The current repo docs are out of date and reference earlier
failed experiments.

This document captures the FINAL working state. Use it to bring the repo
up to date.

## TL;DR — the working configs

**PX13 (ASUS ProArt, Ryzen AI Max+ 395, Radeon 8060S, 128 GB unified)**
- **Tool**: Claude Code (via `claude-smart --local`)
- **Model**: Qwen3-Coder-30B-A3B Q4_K_M
- **Runtime**: kyuz0 prebuilt image `docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.3` via distrobox
- **Backend**: ROCm 7.2.3
- **Context**: 256K, single slot
- **Perf**: ~26 t/s gen, ~300+ t/s prefill, ~2 min cold start
- **Status**: production daily driver

**Zenbook Duo (Intel Core Ultra 9 185H Meteor Lake, 32 GB, Arc iGPU)**
- **Tool**: Aider (NOT Claude Code — see "why" below)
- **Model**: Qwen2.5-Coder-3B-Instruct Q4_K_M
- **Runtime**: official `ghcr.io/ggml-org/llama.cpp:server-vulkan` via direct podman
- **Backend**: Vulkan on Arc iGPU (NOT CPU — this matters)
- **Context**: 32K native (model's max, no extension needed for Aider)
- **Perf**: ~250 t/s prefill, ~12 t/s gen on iGPU, cache reuse works
- **Status**: snappy working setup

Both machines on Bazzite (Fedora Atomic).

## Concrete tasks

1. **Rewrite `docs/ZENBOOK-DUO.md`** completely — switch from any CPU /
   DeepSeek-V2-Lite / Qwen3.5-x narrative to the actual working config
   (Aider + Qwen2.5-Coder-3B + Vulkan + ghcr.io/ggml-org/llama.cpp:server-vulkan).

2. **Update `systemd/llama-server-duo.service`** to the new working unit
   (see the working unit in this doc).

3. **Create `docs/AIDER-SETUP.md`** covering Aider installation via uv
   and config for the local llama-server.

4. **Create `docs/VULKAN-NOTES.md`** capturing the Intel Arc Vulkan gotchas
   we learned (huge addressable memory, YaRN ignored, etc).

5. **Update top-level `README.md`** to describe the two-tool architecture:
   PX13 uses Claude Code on ROCm GPU, Duo uses Aider on Vulkan iGPU.

6. **Update `install.sh`** so `--duo` mode references the Vulkan image,
   Qwen2.5-Coder-3B model path/alias, and `--device /dev/dri` flag.

7. **Create `docs/JOURNAL.md`** capturing the investigative journey
   (failed paths, what we learned). This is genuinely useful war-story
   content for the next person.

8. **Final commit** with the commit message at the end of this doc.

Do NOT touch:
- `bin/claude-smart` (still works for PX13 / future Tailscale bridge)
- `docs/PX13-BAZZITE.md` (still accurate)
- `docs/TAILSCALE-BRIDGE.md` (still accurate, recommended Duo path when on internet)
- `systemd/llama-server-px13.service`
- `LICENSE`, `CONTRIBUTING.md`, `.gitignore`

---

## The CRITICAL final working Duo unit

Path: `~/.config/systemd/user/llama-server.service`

```ini
[Unit]
Description=llama.cpp server (Qwen2.5-Coder-3B for Aider, Vulkan on Arc iGPU)
After=network.target

[Service]
Type=simple
ExecStartPre=-/usr/bin/podman rm -f llama-server
ExecStart=/usr/bin/podman run --rm --name llama-server --device /dev/dri -p 127.0.0.1:8080:8080 -v /var/home/%u/models:/models:z ghcr.io/ggml-org/llama.cpp:server-vulkan -m /models/qwen2.5-coder-3b/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf --host 0.0.0.0 --port 8080 --alias qwen2.5-coder-3b -ngl 999 --parallel 1 -c 32768 --jinja --temp 0.7 --top-p 0.8 --top-k 20
ExecStop=/usr/bin/podman stop -t 5 llama-server
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

The systemd/llama-server-duo.service reference file in the repo should
match this exactly (with appropriate %u and template comments).

## Aider config (~/.aider.conf.yml)

```yaml
openai-api-base: http://127.0.0.1:8080/v1
openai-api-key: local-no-auth-needed
model: openai/qwen2.5-coder-3b
weak-model: openai/qwen2.5-coder-3b
auto-commits: false
dirty-commits: false
edit-format: diff
```

## Model download

```bash
hf download bartowski/Qwen2.5-Coder-3B-Instruct-GGUF \
  --include "*Q4_K_M*" \
  --local-dir ~/models/qwen2.5-coder-3b
```

About 1.9 GB.

## Aider installation (only reliable path on Bazzite)

Bazzite's system Python is currently 3.14. Aider pins `numpy==1.24.3`
which won't build on Python 3.14. `pip install` fails. The clean path:

```bash
# Install uv
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc

# Install aider with its own Python 3.12
uv tool install --python 3.12 aider-chat
```

Aider lands at `~/.local/bin/aider`. Bombproof — uv handles Python
version chaos automatically.

---

## CRITICAL Vulkan-specific lessons (write these into docs/VULKAN-NOTES.md)

These are non-obvious findings from testing Vulkan on Intel Arc iGPU on
Meteor Lake. Future-us will need them.

### 1. Use the `server-vulkan` image, NOT plain `server`

```
✓ ghcr.io/ggml-org/llama.cpp:server-vulkan    (has Vulkan compiled in)
✗ ghcr.io/ggml-org/llama.cpp:server           (CPU only)
```

Two different images. The plain `:server` will run on CPU even with
`-ngl 999`. Use the `:server-vulkan` tag explicitly.

### 2. You MUST pass `--device /dev/dri` to podman

Without this, the container can't see the iGPU. Vulkan silently falls
back to CPU and you'll wonder why it's slow.

```
✓ podman run ... --device /dev/dri ...
✗ podman run ... ...                  (no GPU access)
```

### 3. Add `-ngl 999` to offload all layers

`-ngl 999` tells llama-server "offload all model layers to the GPU." Without
this flag the model runs on CPU even if Vulkan is detected. The "999" is
just "more than any model has" — a sentinel that means "all."

### 4. Intel Arc iGPU on Meteor Lake reports HUGE addressable memory

Surprising finding: llama.cpp on Vulkan reports Arc iGPU as having
**~23 GB of addressable "VRAM"** on a 32 GB Duo. This is because the
iGPU can address most of system memory as GPU memory (unified memory
architecture). Way more than expected — easily fits 8B+ models with
big contexts.

Don't assume Intel iGPUs are memory-constrained the way you might assume
older laptop dGPUs were.

### 5. Vulkan ignores YaRN flags

If you try to extend model context past native with
`--rope-scaling yarn --rope-scale 2 --yarn-orig-ctx <N>`, the Vulkan
backend silently caps at the model's native context anyway. The flags
parse but have no effect.

Workaround: pick a model with sufficient NATIVE context for your use case.
Qwen2.5-Coder-3B's 32K native is plenty for Aider; would have been
insufficient for Claude Code (which injects 35K+).

### 6. Prefill speed is GREAT, generation is moderate

Real measurements on Arc iGPU + Vulkan:
- **Prefill**: 200-365 t/s (PX13-class speeds, surprising)
- **Generation**: 10-15 t/s (similar to CPU, memory-bandwidth-bound)

Prefill is compute-bound and benefits hugely from GPU. Generation is
memory-bandwidth-bound and the iGPU shares the same DDR5 bus as CPU,
so no speedup there. Net effect for users: cold starts feel fast,
streaming feels normal.

### 7. Bigger models hit prefill deceleration on iGPU

For Qwen2.5-Coder-3B at 4K tokens: ~260 t/s
For Llama-3.1-8B at 4K tokens: ~155 t/s, dropping to 92 t/s by 6K

The iGPU shows diminishing returns as KV cache grows. Smaller models
maintain throughput much better. For Duo daily use, prefer 3-4B over
7-8B even when memory allows the bigger model.

### 8. SELinux still requires `:z` on Vulkan setup

Same as CPU setup. Mount the model directory with `:z`:

```
-v /var/home/leandro/models:/models:z
```

Without `:z`, container gets "Permission denied" trying to read the
GGUF file. Not Vulkan-specific but easy to forget when reusing CPU configs.

### 9. Verify Vulkan is actually engaged

Don't trust that adding `--device /dev/dri -ngl 999` worked. Verify:

```bash
journalctl --user -u llama-server --since "5 minutes ago" --no-pager \
  | grep -iE "vulkan|ggml_vulkan"

# Should see:
#   ggml_vulkan: Found 1 Vulkan devices
#   Vulkan0 : Intel(R) Arc(tm) Graphics (MTL) (23576 MiB, 20354 MiB free)
```

If those lines don't appear in the load output, the image, devices, or
ngl flag is misconfigured.

Or simpler: run a small smoke test and check the token speed. If you see
200+ t/s prefill you're on Vulkan. If you see 25-40 t/s, you fell back to
CPU.

### 10. Check iGPU is actually busy during inference

```bash
sudo dnf install -y intel-gpu-tools
sudo intel_gpu_top
```

During an active inference request, you should see render/compute units
pegged. If they're idle while your CPU is at 100%, Vulkan offload
isn't working despite what the logs claim.

---

## The Claude Code timeout wall — DO NOT REOPEN

Today's session conclusively demonstrated that **Claude Code is not
compatible with the Duo regardless of model or backend**. Document this
clearly so future-us doesn't try again.

**Findings:**

- Claude Code injects 30-55K tokens on first message (system prompt +
  tool definitions + claude-mem injection)
- Claude Code has internal request timeouts that fire at ~10-12 minutes,
  even when `ANTHROPIC_API_TIMEOUT_MS=3600000` is set
- The Duo's Arc iGPU prefill speed at 30K+ tokens is roughly 100 t/s
  (decelerating from 200+ at start)
- 30K tokens at avg 120 t/s = 4 min just for prefill, then generation
- Add network jitter, retry overhead, and the timeout WILL fire in
  practice (we observed it consistently at the 10-12 min mark)
- No model size fixes this: Qwen3.5-9B, Qwen3.5-4B, Qwen3.5-0.8B,
  Llama-3.1-8B, Qwen2.5-Coder-3B all hit the same wall

**The answer**: don't try to run Claude Code locally on the Duo. Use:
- Aider locally (this doc)
- Or claude-smart over Tailscale to the PX13 (`docs/TAILSCALE-BRIDGE.md`)
- Or the real Anthropic API

---

## Models tested today (for the JOURNAL doc)

| Model | Size Q4 | Where tested | Result |
|---|---|---|---|
| Qwen2.5-Coder-7B | 4.4 GB | CPU then GPU | 32K native too small for Claude Code |
| Qwen2.5-Coder-14B | 8.4 GB | CPU | Same 32K wall, slower |
| DeepSeek-Coder-V2-Lite Instruct 16B MoE | 10 GB | CPU | Hallucinates tools, refuses tasks, raw special-token leakage |
| Qwen3.5-9B | 6 GB | CPU | Works correctly but Claude Code times out before prefill completes |
| Qwen3.5-4B | 3 GB | CPU | Cache invalidation hell (hybrid attention not supported by llama.cpp checkpoint reuse) |
| Qwen3.5-0.8B | 0.5 GB | CPU | Fast but too small for reliable tool use, and Claude Code still times out on multi-turn |
| Llama-3.1-8B-Instruct | 4.6 GB | GPU/Vulkan | Worked, 128K native — but too big for snappy Duo perf, Claude Code timeout still fires |
| **Qwen2.5-Coder-3B + Vulkan + Aider** | 1.9 GB | GPU/Vulkan | **✅ WORKS GREAT** — cache reuse functions, snappy, agentic, daily-driver ready |

---

## Why Aider works where Claude Code doesn't

Document this comparison in `docs/AIDER-SETUP.md` because it's the core
architectural insight:

| Aspect | Claude Code | Aider |
|---|---|---|
| System prompt size | 15-25K tokens | 3-5K tokens |
| claude-mem auto-injection | Yes (+10-20K) | No |
| File context model | Auto-discovered, agent reads on demand | User says `/add file.js`, only those files load |
| Typical first-message context | 30-55K tokens | 5-10K tokens |
| Cold prefill at 250 t/s | ~2-3 min (BORDERLINE) | ~25 sec (snappy) |
| Internal request timeout | ~10-12 min hard cap | None |
| Tool model | Free-form agent calling many tools | Constrained: ask for diff or whole file |
| Failure mode on small models | Refuses, hallucinates, narrates | Usually OK, retries on bad diff |

Aider trades autonomy for reliability. For CPU/iGPU-class hardware, that
trade is the right one.

---

## SELinux gotcha (still relevant in Vulkan setup)

Bazzite uses SELinux. Volume mounts MUST have `:z`:

```
-v /var/home/leandro/models:/models:z
```

Without `:z`, the container gets "Permission denied" trying to read the
GGUF file even though the host user owns it. Symptom:

```
gguf_init_from_file: failed to open GGUF file '...' (Permission denied)
```

`:z` tells podman to relabel with `container_file_t`. One-time relabel
on each new container; subsequent runs are no-op.

## Systemd line-continuation gotcha (still relevant)

Multi-line `ExecStart` with backslash continuations is fragile. ANY
trailing whitespace after a `\` breaks parsing with:

```
error: invalid argument: \
```

Use ONE long line. systemd doesn't care about readability; we do, but
not at the cost of breakage. Or use `cat > file <<'EOF' ... EOF` to
avoid editor whitespace issues entirely.

## Useful Aider features to mention in docs/AIDER-SETUP.md

- `aider --restore-chat-history` — continues previous session
- `.aider.chat.history.md` — readable markdown log of all sessions
  (per project root)
- `.aider.input.history` — your previous prompts (recall with up-arrow)
- `/add <file>` — add file to context mid-session
- `/drop <file>` — remove file from context
- `/clear` — clear context (use sparingly, kills warm cache)
- `/undo` — undo last applied edit
- `/diff` — review pending edits before accepting

## What's still planned but not done

- Tailscale bridge from Duo to PX13 (docs at `docs/TAILSCALE-BRIDGE.md`
  already written, just not implemented in practice)
- Browser dashboard for llama-server logs (PX13 has `--slots` and
  `--metrics` enabled; Claude Code on PX13 started building one earlier)
- Per-project `CLAUDE.md` with MCP descriptions (Beeper, Notion,
  FloorIQ, css-cockpit, lsz-devlog) for future local model experiments

---

## Smoke test pattern for the working setup

```bash
# 1. Start the server
systemctl --user start llama-server.service
sleep 20

# 2. Verify Vulkan + model
curl -s http://127.0.0.1:8080/v1/models | jq '.data[0].id'
# Expect: "qwen2.5-coder-3b"

curl -s http://127.0.0.1:8080/props | jq '.default_generation_settings.n_ctx'
# Expect: 32768

journalctl --user -u llama-server --since "5 minutes ago" --no-pager \
  | grep -iE "vulkan|ggml_vulkan"
# Expect: Vulkan0 : Intel(R) Arc(tm) Graphics (MTL) ...

# 3. Anthropic-format smoke test
curl -s http://127.0.0.1:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen2.5-coder-3b","max_tokens":100,"messages":[{"role":"user","content":"Write a python function to reverse a string."}]}' \
  | jq

# 4. Check the timing
journalctl --user -u llama-server -n 10 --no-pager | grep -E "eval time"
# Expect: prefill ~200-300 t/s, gen ~10-15 t/s

# 5. Real Aider test
mkdir -p /tmp/aider-test && cd /tmp/aider-test
git init && echo "# Test" > README.md && git add . && git commit -m "init"
aider README.md
# Then: "What does this file say?"
# Should respond in ~25 sec total (first message includes cold prefill)
```

---

## Final commit message

```
Duo: final working config — Aider + Qwen2.5-Coder-3B + Vulkan on Arc iGPU

After exhaustive testing today, the Duo's working setup is:
- Aider (lighter than Claude Code, smaller injected context)
- Qwen2.5-Coder-3B-Instruct Q4_K_M (standard attention, cache reuse works)
- ghcr.io/ggml-org/llama.cpp:server-vulkan (NOT plain :server)
- Intel Arc iGPU via Vulkan (--device /dev/dri -ngl 999)

Performance: ~250 t/s prefill, ~12 t/s gen, ~25 sec for 4K-token Aider
turn. Cache reuse functions correctly (vs Qwen3.5 hybrid attention which
invalidates cache every turn).

Key findings documented:
- Claude Code's request timeout (~10-12 min) is incompatible with CPU
  and iGPU inference for its 30-55K token context. No model fixes this.
- Vulkan on Arc iGPU is much more capable than expected: reports ~23 GB
  addressable memory on Meteor Lake's unified architecture.
- Vulkan silently ignores YaRN context extension flags. Use models with
  sufficient NATIVE context.
- DeepSeek-Coder-V2-Lite hallucinates tool calls (coder-trained, not
  agentic-trained). Avoid for tool-use scenarios.
- Qwen3.5 family has hybrid attention (Gated DeltaNet) that current
  llama.cpp can't cache reuse correctly. Causes full re-prefill on
  every turn even with --cache-reuse and --swa-full flags.
- Aider config: use openai/<alias> model name to match llama-server
  --alias flag. Set weak-model to same to prevent OpenAI API calls.

Changes:
- docs/ZENBOOK-DUO.md: complete rewrite for Aider + Qwen2.5-Coder-3B + Vulkan
- docs/AIDER-SETUP.md: new, covers uv-based aider install + config
- docs/VULKAN-NOTES.md: new, Intel Arc iGPU gotchas
- docs/JOURNAL.md: new, captures the investigative journey
- systemd/llama-server-duo.service: updated to Vulkan + Qwen2.5-Coder-3B
- install.sh: --duo mode now references server-vulkan image + model paths
- README.md: documents two-tool architecture (Claude Code on PX13 ROCm,
  Aider on Duo Vulkan)

Tested on Zenbook Duo Core Ultra 9 185H (Meteor Lake, 32 GB, Arc iGPU).
```

---

## How to approach this work

1. Read the current `docs/ZENBOOK-DUO.md` to see what's wrong.
2. Read `systemd/llama-server-duo.service` to see what's wrong.
3. Read top-level `README.md` to see what's wrong.
4. Read `install.sh` `--duo` branch to see what's wrong.
5. Plan changes, then execute file-by-file with `git diff <file>` after each.
6. Create new docs (`AIDER-SETUP.md`, `VULKAN-NOTES.md`, `JOURNAL.md`)
   with the content sketched above. Flesh out into proper docs;
   don't just copy this file's bullet points.
7. Final `git status` and `git diff --stat` to review scope.
8. Commit with the message above. Confirm with user before pushing if
   anything looks unexpected.

The user is exhausted. Be thorough, ask sparingly, ship clean work.
This is a long-day epic and deserves a polished commit.

Good luck, future Claude.
