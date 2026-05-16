# Zenbook Duo (Core Ultra 9, 32 GB) — Bazzite Setup

The Zenbook Duo has an Intel Core Ultra 9 185H with Arc integrated graphics.
**The Arc iGPU is the inference backend here** — Vulkan puts it to work and
delivers ~250 t/s prefill with Qwen2.5-Coder-3B. This is a capable local
inference machine, not a "CPU fallback" box.

**Three options for this machine, ordered by what you should actually use:**

1. **[Tailscale bridge to PX13](TAILSCALE-BRIDGE.md)** — recommended for
   internet-connected daily use. Full 30B perf from anywhere.
2. **Local Vulkan inference with Aider** — covered here. Offline-capable,
   snappy with the right setup (~25 sec first response).
3. **Real Anthropic API via plain `claude`** — when online and not API-limited.

This doc covers option 2. The working tool is **Aider + Qwen2.5-Coder-3B +
Vulkan on Arc iGPU**, not Claude Code.

> **Why not Claude Code locally?** Claude Code's internal request timeout
> (~10-12 min) can't be overridden via env vars. Even with the iGPU, Claude
> Code's 30-55K context injection takes too long to prefill before the timeout
> fires — and the tool retries indefinitely without ever generating output. See
> [The Claude Code timeout wall](#8-the-claude-code-timeout-wall) for the full
> analysis. Aider sidesteps this by injecting ~5-10K tokens instead.

---

## Hardware

- **CPU**: Intel Core Ultra 9 185H (Meteor Lake) — AVX2 + AVX-VNNI
- **iGPU**: Intel Arc Graphics (MTL) — used for inference via Vulkan
- **RAM**: 32 GB DDR5 (unified, shared with iGPU)
- **OS**: Bazzite (Fedora Atomic)

The Arc iGPU reports **~23 GB addressable "VRAM"** to llama.cpp — this is
not a bug. Meteor Lake's unified memory architecture allows the iGPU to
address most of system RAM. Bigger models than you'd expect fit comfortably.

---

## The model: Qwen2.5-Coder-3B-Instruct Q4_K_M

| Property | Value | Why it matters |
|---|---|---|
| Total params | 3B | Low RAM footprint, snappy on iGPU |
| Quantization | Q4_K_M | Good quality/size trade-off |
| Native context | 32K | Matches Aider's injection size exactly |
| Model weights | ~1.9 GB | Fast model load |
| Total runtime RAM | ~3-4 GB | Well within unified 32 GB |
| Prefill speed | ~250 t/s | Cold start ~25 sec for a 4K-token turn |
| Generation speed | ~12 t/s | Each response token streams in real time |

**Why Aider and not Claude Code?** Aider injects ~5-10K context per session
vs 30-55K for Claude Code. Aider's cold start: ~25 seconds. Claude Code's
cold start would need ~4+ minutes just for prefill — and then times out before
generating. See the [comparison table](#why-aider) below.

---

## 1. Bazzite setup

No special kernel args needed. The Vulkan setup uses `--device /dev/dri` via
podman — no GPU kernel arguments, no IOMMU changes.

Confirm your instruction set (informational):

```bash
grep -oE "(avx[^ ]*|vnni[^ ]*)" /proc/cpuinfo | sort -u
```

Meteor Lake shows `avx`, `avx2`, `avx_vnni`. The prebuilt container handles
this automatically — no manual flag tuning.

---

## 2. Model download

```bash
hf download bartowski/Qwen2.5-Coder-3B-Instruct-GGUF \
  --include "*Q4_K_M*" \
  --local-dir ~/models/qwen2.5-coder-3b
```

About 1.9 GB. Verify:

```bash
ls -lh ~/models/qwen2.5-coder-3b/
# Should see: Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf (~1.9 GB)
```

---

## 3. The container — `server-vulkan` image

**Use the `server-vulkan` tag, not plain `server`.** They are two distinct
images. The plain `:server` tag runs on CPU even with `-ngl 999` and
`--device /dev/dri`. Always use `:server-vulkan` explicitly.

```bash
podman pull ghcr.io/ggml-org/llama.cpp:server-vulkan
```

About 300 MB.

**Manual test first** (catch issues before wiring systemd):

```bash
podman run --rm -it \
  --device /dev/dri \
  -p 127.0.0.1:8080:8080 \
  -v /var/home/leandro/models:/models:z \
  ghcr.io/ggml-org/llama.cpp:server-vulkan \
  -m /models/qwen2.5-coder-3b/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8080 \
  --alias qwen2.5-coder-3b \
  -ngl 999 --parallel 1 -c 32768 --jinja \
  --temp 0.7 --top-p 0.8 --top-k 20
```

**Critical flags:**

- `--device /dev/dri` — without this, the container can't see the iGPU and
  silently falls back to CPU.
- `-ngl 999` — offloads all model layers to GPU. Without this flag, the model
  runs on CPU even when Vulkan is detected.
- `:z` on the volume mount — Bazzite uses SELinux. Without `:z`, the container
  gets "Permission denied" reading the GGUF file even though the host user owns
  it. See [`VULKAN-NOTES.md`](VULKAN-NOTES.md) for details.

**Expected startup log lines:**

```
ggml_vulkan: Found 1 Vulkan devices
Vulkan0 : Intel(R) Arc(tm) Graphics (MTL) (23576 MiB, 20354 MiB free)
n_ctx = 32768
model size = 1.9 GiB
server is listening on http://0.0.0.0:8080
```

If the Vulkan lines are absent, see [Troubleshooting](#10-troubleshooting).

Smoke test from another terminal:

```bash
curl -s http://127.0.0.1:8080/v1/models | jq '.data[0].id'
# Expected: "qwen2.5-coder-3b"
```

Then `Ctrl+C` the foreground run.

---

## 4. systemd user service

Use the reference unit at
[`../systemd/llama-server-duo.service`](../systemd/llama-server-duo.service),
or write it directly to `~/.config/systemd/user/llama-server.service`:

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

**Use ONE long `ExecStart` line.** Any backslash continuation with trailing
whitespace breaks systemd with `error: invalid argument: \`.

Install and start:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/llama-server-duo.service ~/.config/systemd/user/llama-server.service
systemctl --user daemon-reload
systemctl --user start llama-server.service
```

Watch it load:

```bash
journalctl --user -u llama-server -f
```

---

## 5. Install Aider

See [`AIDER-SETUP.md`](AIDER-SETUP.md) for full installation steps. TL;DR:

```bash
# Install uv (Python toolchain manager)
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc

# Install Aider with isolated Python 3.12
uv tool install --python 3.12 aider-chat
```

Configure `~/.aider.conf.yml`:

```yaml
openai-api-base: http://127.0.0.1:8080/v1
openai-api-key: local-no-auth-needed
model: openai/qwen2.5-coder-3b
weak-model: openai/qwen2.5-coder-3b
auto-commits: false
dirty-commits: false
edit-format: diff
```

The `openai/` prefix tells Aider to use OpenAI-compatible API format against
llama.cpp's `/v1/chat/completions`. The model name must match the `--alias`
flag in the systemd unit exactly.

Then use it:

```bash
cd ~/your-project
aider src/main.py
```

---

## 6. Performance expectations

Measured on Duo with Core Ultra 9 185H, Arc iGPU, Vulkan, Qwen2.5-Coder-3B:

| Action | Time |
|---|---|
| Model load (service start → ready) | 20-30 sec |
| First message (cold, ~4K Aider context) | ~25 sec |
| Follow-up messages (warm KV cache) | 10-20 sec |
| Generation streaming | ~12 t/s |
| System memory used | ~3-4 GB |

**What this setup handles well:**

- ✅ Single-file edits and refactors
- ✅ Multi-file work via explicit `/add` in Aider
- ✅ Code explanation and review
- ✅ Offline use — flights, conferences, dead zones
- ⚠️ Very long sessions slow down as context fills up over many turns
- ❌ Real production work — use real `claude` or PX13 via Tailscale
- ❌ Claude Code locally — it times out before generating (see below)

**Priority order for this machine:**

1. Real Claude API when online (primary)
2. Tailscale to PX13 when reachable — full 30B perf, full Claude Code
3. Aider + local Qwen2.5-Coder-3B only when both above are unavailable

---

## 7. Verify Vulkan is active

After starting the service, confirm the iGPU is actually being used:

```bash
journalctl --user -u llama-server --since "5 minutes ago" --no-pager \
  | grep -iE "vulkan|ggml_vulkan"
```

Expected:

```
ggml_vulkan: Found 1 Vulkan devices
Vulkan0 : Intel(R) Arc(tm) Graphics (MTL) (23576 MiB, 20354 MiB free)
```

If those lines don't appear, see [Troubleshooting](#10-troubleshooting).

Speed heuristic: if prefill is 200+ t/s, Vulkan is working. If prefill is
25-40 t/s, you fell back to CPU.

See [`VULKAN-NOTES.md`](VULKAN-NOTES.md) for all Arc iGPU gotchas.

---

## 8. The Claude Code timeout wall

Claude Code has internal request timeouts that abort backend requests after
~10-12 minutes, even when:
- `ANTHROPIC_API_TIMEOUT_MS=3600000` is set (env var only affects HTTP client)
- The backend is actively prefilling and about to generate

The failure pattern:

```
W srv next: stopping wait for next result due to should_stop condition
W srv next: ref: https://github.com/ggml-org/llama.cpp/pull/22907
W srv stop: cancel task, id_task = N
```

Claude Code retries, gets a partial cache hit (~5-30% overlap), restarts
prefill from the cache boundary, times out again — infinite loop. The model
never generates output.

**Why the iGPU doesn't save you:**

Claude Code injects 30-55K tokens of context on first message. At 100 t/s
prefill (a realistic Arc iGPU estimate once KV cache grows), that's ~5-9
minutes just for prefill. Add generation time and Claude Code's timeout fires
reliably before the first response.

| Model | Prefill speed | 50K tokens | Result |
|---|---|---|---|
| Any model | ~100 t/s (iGPU) | ~8 min | Consistently times out |
| Any model | ~24-37 t/s (CPU) | 22-35 min | Times out even faster |

No model size fixes this on Duo hardware. The problem is Claude Code's context
injection size × the timeout.

**The answer:** use Aider (this doc) or Tailscale to PX13 instead.

---

<a name="why-aider"></a>
## Why Aider works where Claude Code doesn't

| Aspect | Claude Code | Aider |
|---|---|---|
| System prompt | ~15-25K tokens | ~3-5K tokens |
| Memory injection (claude-mem) | +10-20K automatically | None |
| File context model | Agent auto-discovers files | User `/add`s files explicitly |
| Typical first-message context | 30-55K tokens | 5-10K tokens |
| Prefill at 250 t/s | ~2-4 min (iGPU, borderline/over) | ~25 sec (snappy) |
| Internal request timeout | ~10-12 min (hard, not overridable) | None |
| Failure mode on small models | Refuses, hallucinates, narrates | Usually retries on bad diff |

Aider trades autonomy for reliability. For iGPU-class hardware, that trade
is the right one.

---

## 9. Models tested and verdict

Testing done May 2026 — full details in [`JOURNAL.md`](JOURNAL.md).

| Model | Size | Backend | Result |
|---|---|---|---|
| DeepSeek-Coder-V2-Lite Instruct (16B MoE) | 10 GB | CPU | ⚠️ Hallucinates tool calls, emits raw `<\|tool_calls_begin\|>` tokens. Coder-trained, not agentic-trained. |
| Qwen2.5-Coder-7B Q4_K_M | 4.4 GB | CPU | ❌ 32K native context too small — Claude Code's first message exceeds it immediately. |
| Qwen2.5-Coder-14B | 8.4 GB | CPU | ❌ Same 32K ceiling, slower. |
| Qwen3.5-9B Q4_K_XL | 6 GB | CPU | ⚠️ Correct behavior, but 24 t/s × 50K tokens = 35 min. Times out every time. |
| Qwen3.5-4B Q4_K_XL | 3 GB | CPU | ⚠️ 37 t/s, still ~22 min. Times out same way. |
| Qwen3.5-0.8B Q4_K_XL | 0.5 GB | CPU | ⚠️ 200 t/s, beats the timeout. But output quality too low for reliable tool use. |
| Llama-3.1-8B-Instruct | 4.6 GB | Vulkan | ⚠️ Worked. 128K native context, 12 t/s gen. But too slow on iGPU for snappy use, and Claude Code timeout still fires. |
| **Qwen2.5-Coder-3B Q4_K_M + Vulkan + Aider** | 1.9 GB | Vulkan | ✅ **Daily driver.** Cache reuse works correctly. ~250 t/s prefill, ~12 t/s gen, ~25 sec cold start. |

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| No Vulkan lines in startup logs | Wrong image or missing `--device /dev/dri` | Check you're using `:server-vulkan`, not `:server`; confirm `--device /dev/dri` is in the run command |
| Prefill speed is 25-40 t/s instead of 200+ | Vulkan fell back to CPU | See above |
| Container can't read model | SELinux blocking volume mount | Add `:z` to the volume spec: `-v /path:/models:z` |
| `error: invalid argument: \` | Trailing whitespace after `\` in systemd ExecStart | Use one long ExecStart line, no `\` continuations |
| Port 8080 already in use | Old llama-server still running | `systemctl --user stop llama-server.service && podman rm -f llama-server` |
| OOM during load | Unlikely with 3B model, but possible if RAM is full | Close other apps; 3B should use ~3-4 GB total |
| Context size exceeded | Using wrong model or `-c` value too low | Verify `--alias qwen2.5-coder-3b` and `-c 32768` in ExecStart |
| Aider edit format errors | Model struggling with diff format | Try `edit-format: whole` in `~/.aider.conf.yml` |
| `</s>` warning on model load | Harmless cosmetic noise | Ignore |

---

**Maintained by:** Leandro Sanchez, Enhance Tech.
