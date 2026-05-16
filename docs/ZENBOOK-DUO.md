# Zenbook Duo (Core Ultra 9, 32 GB) — Bazzite Setup

Companion setup to the PX13 runbook for a **CPU-class machine without a real
GPU accelerator**. The Zenbook Duo has an Intel Core Ultra 9 185H with Arc
integrated graphics — useful for display but not competitive with discrete
GPUs or AMD APUs for LLM workloads.

**Three options for this machine, ordered by what you should actually use:**

1. **[Tailscale bridge to PX13](TAILSCALE-BRIDGE.md)** — recommended for daily use.
   Full 30B perf from anywhere with internet.
2. **Local CPU inference with Aider** — covered here. Offline-capable backup, ~10 t/s gen.
3. **Real Anthropic API via plain `claude`** — when online and not API-down.

This doc covers option 2 — the "I'm on a plane and the Anthropic API is also
down somehow" tier. The actual working tool is **Aider + Qwen3.5-4B**, not
Claude Code.

> **Why not Claude Code locally?** Claude Code's internal request timeout
> (~10-12 min) cannot be overridden by env vars. CPU prefill at 24-37 t/s
> across Claude Code's 30-55K context injection takes 14-35 min — always
> longer than the timeout. No model size fixes this. See
> [The Claude Code timeout wall](#8-the-claude-code-timeout-wall) below.

---

## Hardware tested

- **CPU**: Intel Core Ultra 9 185H (Meteor Lake) — AVX2 + VNNI, no AVX-512
- **RAM**: 32 GB
- **GPU**: Arc integrated (not used for inference)
- **OS**: Bazzite (Fedora Atomic)

**Note for Lunar Lake users** (Core Ultra 9 200V series): Intel stripped
AVX-512 from those SKUs. The setup below uses the official prebuilt
llama.cpp container which handles both — no special build flags needed.

---

## The model: Qwen3.5-4B UD-Q4_K_XL

After extensive testing (see [Models tested and verdict](#9-models-tested-and-verdict)),
Qwen3.5-4B with Unsloth's Dynamic 2.0 quant is the right choice for Aider
on the Duo:

| Property | Value | Why it matters |
|---|---|---|
| Total params | 4B | Fits easily in 32 GB |
| Quantization | UD-Q4_K_XL (Unsloth Dynamic 2.0) | Best quality at this size |
| Native context | 128K | Plenty for Aider's ~5-10K injection |
| Model weights | ~3 GB | Fast load, small RAM footprint |
| KV cache at 64K | ~1.5 GB | Total runtime ~8-9 GB |
| Generation speed | ~10 t/s | Follow-ups under 1 min |

**Why Aider and not Claude Code?** Aider injects only ~5-10K tokens of context
per session vs 30-55K for Claude Code + claude-mem. Cold start: 2-4 min instead
of 14-35 min that always exceeds Claude Code's timeout.

---

## 1. Bazzite setup

No special kargs needed — CPU inference doesn't care about GTT or IOMMU.

Confirm your CPU's instruction set support (informational):

```bash
grep -oE "(avx[^ ]*|vnni[^ ]*)" /proc/cpuinfo | sort -u
```

- **Meteor Lake & older**: shows `avx`, `avx2`, `avx_vnni`, often `avx512*`
- **Lunar Lake (200V series)**: shows `avx`, `avx2`, `avx_vnni` (no AVX-512)

The prebuilt container handles both — no manual flag tuning needed.

---

## 2. Model download

```bash
hf download unsloth/Qwen3.5-4B-GGUF \
  --include "*UD-Q4_K_XL*" \
  --local-dir ~/models/qwen3.5-4b
```

About 3 GB. Verify when done:

```bash
ls -lh ~/models/qwen3.5-4b/
```

You should see `Qwen3.5-4B-UD-Q4_K_XL.gguf` (~3 GB).

---

## 3. The container — official llama.cpp prebuilt server image

**Skip the build-from-source path.** Use the official prebuilt image instead.
It tracks master HEAD, ships with the `/v1/messages` Anthropic Messages API
endpoint, and includes x86 CPU optimizations out of the box.

**Use direct podman, not distrobox.** Distrobox adds unnecessary complexity
(seccomp, group passthrough, shell wrapping) for a server use case.

```bash
podman pull ghcr.io/ggml-org/llama.cpp:server
```

About 200 MB. Done.

**Manual test first** (so you catch issues before wiring systemd):

```bash
podman run --rm -it \
  -p 127.0.0.1:8080:8080 \
  -v /var/home/leandro/models:/models:z \
  ghcr.io/ggml-org/llama.cpp:server \
  -m /models/qwen3.5-4b/Qwen3.5-4B-UD-Q4_K_XL.gguf \
  --host 0.0.0.0 --port 8080 \
  --alias qwen3.5-4b \
  -c 65536 --parallel 1 -t 16 --jinja \
  --reasoning off --temp 1.0 --top-p 0.95 --top-k 20 --presence-penalty 1.5
```

**Critical flag: `:z` on the volume mount.** Bazzite uses SELinux. Without
`:z`, the container can't read the model file (you'll get "Permission denied"
in the logs). The `:z` tells podman to relabel the directory for shared
container access.

**Qwen3.5 sampling flags explained:**

- `--reasoning off` — disables think-mode. Without this, the model emits
  `<think>...</think>` blocks before every response. Aider doesn't expect them.
- `--temp 1.0 --top-p 0.95 --top-k 20 --presence-penalty 1.5` — Qwen's
  official recommended non-thinking sampling parameters. Different from
  Qwen2.5 or Qwen3-Coder defaults.

Watch for these in the startup logs:
- `n_ctx = 65536` — 64K context loaded
- `model size = 2.7 GiB` — weights in memory
- `server is listening on http://0.0.0.0:8080` — the win condition

Smoke test from another terminal:

```bash
curl -s http://127.0.0.1:8080/v1/models | jq '.data[0].id'
# Expected output: "qwen3.5-4b"
```

Then `Ctrl+C` the foreground run.

---

## 4. systemd user service

Use the reference unit at [`../systemd/llama-server-duo.service`](../systemd/llama-server-duo.service),
or write it directly to `~/.config/systemd/user/llama-server.service`:

```ini
[Unit]
Description=llama.cpp server (Qwen3.5-4B for Aider/light agentic, CPU prebuilt)
After=network.target

[Service]
Type=simple
ExecStartPre=-/usr/bin/podman rm -f llama-server
ExecStart=/usr/bin/podman run --rm --name llama-server -p 127.0.0.1:8080:8080 -v /var/home/%u/models:/models:z ghcr.io/ggml-org/llama.cpp:server -m /models/qwen3.5-4b/Qwen3.5-4B-UD-Q4_K_XL.gguf --host 0.0.0.0 --port 8080 --alias qwen3.5-4b --parallel 1 -c 65536 -t 16 --jinja --reasoning off --temp 1.0 --top-p 0.95 --top-k 20 --presence-penalty 1.5
ExecStop=/usr/bin/podman stop -t 5 llama-server
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

**Critical: use ONE long `ExecStart` line.** Any backslash continuation with
a trailing space breaks systemd parsing with `error: invalid argument: \`.

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

See [`AIDER-SETUP.md`](AIDER-SETUP.md) for the full installation steps. TL;DR:

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
model: openai/qwen3.5-4b
weak-model: openai/qwen3.5-4b
auto-commits: false
dirty-commits: false
edit-format: diff
```

Then use it:

```bash
cd ~/your-project
aider src/main.py
```

---

## 6. Realistic performance expectations

Measured on Duo with Core Ultra 9 185H, 32 GB RAM, this exact config:

| Action | Time |
|---|---|
| Model load (service start → ready) | 30-60 sec |
| First message (cold, ~5-10K context) | 2-4 min |
| Follow-up messages | Under 1 min |
| Generation streaming | ~10 t/s |
| System memory used | ~8-9 GB |

**Be honest about the use case:**

- ✅ Single-file edits, refactors, code explanation
- ✅ Multi-file work via explicit `/add` in Aider
- ✅ Quick code questions
- ✅ Truly offline scenarios (flights, conferences with no wifi)
- ⚠️ Long Aider sessions slow down as context fills up over many turns
- ❌ Real production work — use real `claude` or PX13 via Tailscale
- ❌ Claude Code locally — it times out on CPU (see below)

**For this machine, prioritize:**

1. Real Claude API when online (primary)
2. Tailscale to PX13 when reachable (full 30B at PX13 speeds, full Claude Code)
3. Aider + local Qwen3.5-4B only when both above fail

See [`TAILSCALE-BRIDGE.md`](TAILSCALE-BRIDGE.md) for option 2.

---

## 7. Heat & battery

CPU inference pegs ~16 cores at 100% for prefill + generation duration.

- **Plugged in**: fans loud, chassis warm, ~50-65 W package power
- **On battery**: thermal throttle within minutes, battery drains in
  ~30-45 min under sustained load

Fire off a query, get an answer, let it cool. Don't run long autonomous Aider
sessions on battery.

---

## 8. The Claude Code timeout wall

Claude Code (the CLI from Anthropic) has internal request timeouts that
abort backend requests after ~10-12 minutes even when:
- `ANTHROPIC_API_TIMEOUT_MS=3600000` is set (1 hour)
- The backend is actively processing and producing tokens

The log pattern when it hits:

```
W srv next: stopping wait for next result due to should_stop condition
W srv next: ref: https://github.com/ggml-org/llama.cpp/pull/22907
W srv stop: cancel task, id_task = N
```

Then Claude Code retries, gets a partial cache hit (~5-30% similarity),
restarts prefill, hits the timeout again — infinite loop, model never generates.

**This is fundamental.** CPU prefill cannot beat the timeout for Claude Code's
context size. No model swap fixes this on CPU hardware:

| Model | Prefill speed | Time for 50K tokens | Result |
|---|---|---|---|
| Qwen3.5-9B Q4_K_XL | 24 t/s | 35 min | Always times out |
| Qwen3.5-4B Q4_K_XL | 37 t/s | 22 min | Always times out |
| Qwen3.5-0.8B Q4_K_XL | 200 t/s | 4 min | Fast enough, but 0.8B quality is too low for reliable tool use |

Either use a GPU machine (PX13), use Tailscale to one, or use a different
tool (Aider) with smaller context injection.

---

## 9. Models tested and verdict

Full comparison from testing session, May 2026:

| Model | Size | Result on Duo |
|---|---|---|
| Qwen2.5-Coder-7B Q4_K_M | 4.4 GB | ❌ 32K native context too small. First message always fails with "request exceeds available context size". |
| Qwen2.5-Coder-14B | 8.4 GB | ❌ Same 32K context wall, slower than 7B. |
| DeepSeek-Coder-V2-Lite Instruct (16B MoE) | 10 GB | ⚠️ 160K context fits, but hallucinates tool calls. Emits raw `<\|tool_calls_begin\|>` tokens in output. Refuses tasks with "I'm an AI and can't perform tasks on your behalf". Coder-trained, not agentic-trained. |
| Qwen3.5-9B Q4_K_XL | 6 GB | ⚠️ Correct behavior, but 24 t/s prefill × 50K context = 35+ min. Claude Code timeout fires at ~10 min every time. |
| Qwen3.5-4B Q4_K_XL | 3 GB | ⚠️ Better at 37 t/s, but 22 min for full Claude Code context. Times out same way. |
| Qwen3.5-0.8B Q4_K_XL | 0.5 GB | ⚠️ Prefill at 200 t/s, fast enough to beat the timeout. But 0.8B quality is too low for reliable tool use — malformed JSON, hallucinated function names. |
| **Qwen3.5-4B Q4_K_XL with Aider** | 3 GB | ✅ **Actually works.** Aider injects ~5-10K context. Cold start 2-4 min, follow-ups <1 min, ~10 t/s gen. Tool use reliable. |

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Port 8080 already in use | Old llama-server still running | `systemctl --user stop llama-server.service`, `podman rm -f llama-server` |
| Container can't read model | SELinux blocking volume mount | Add `:z` to the volume spec: `-v /path:/models:z` |
| `error: invalid argument: \` | Trailing whitespace in systemd ExecStart continuation | Use one long ExecStart line, no `\` continuations |
| OOM during load | RAM contention | Close browser/IDE; total footprint is ~8-9 GB |
| Aider responses include `<think>` blocks | `--reasoning off` missing from llama-server flags | Restart server with `--reasoning off` in ExecStart |
| `</s>` warning on model load | Harmless cosmetic noise | Ignore |
| 404 on `/v1/messages` | Old llama.cpp build without Anthropic endpoint | Use official `ghcr.io/ggml-org/llama.cpp:server` prebuilt image |
| Aider edit format errors | Model struggling with diff format | Switch to `edit-format: whole` in `~/.aider.conf.yml` |

---

**Maintained by:** Leandro Sanchez, Enhance Tech.
