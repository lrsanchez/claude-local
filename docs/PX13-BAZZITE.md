# PX13 (Strix Halo) — Bazzite Setup

ASUS ProArt PX13 with AMD Ryzen AI Max+ 395 (Radeon 8060S, gfx1151) and 128 GB
unified memory. Runs Qwen3-Coder-30B-A3B Q4_K_M locally as a Claude Code
backend via llama.cpp + ROCm 7.2.3.

**Status: working in production.** Tested May 2026 on Bazzite kernel 6.19.14.

**Real-world performance:** ~319 t/s prefill, ~26 t/s generation at 36K
context. Cold-start first request takes ~2 minutes (full prefill of system
prompt + tools + claude-mem context). Follow-ups are snappy (5-25 sec).

---

## 1. Kernel arguments

Bazzite is immutable. Use `rpm-ostree kargs`:

```bash
sudo rpm-ostree kargs \
  --append=amd_iommu=off \
  --append=amdgpu.gttsize=131072 \
  --append=ttm.pages_limit=31457280

sudo systemctl reboot
```

Verify after reboot:

```bash
cat /proc/cmdline | tr ' ' '\n' | grep -E "iommu|gtt|ttm"
```

Without `gttsize=131072`, the GPU can only address ~1 GB and model load fails.

Rollback if needed: `sudo rpm-ostree rollback`

---

## 2. Distrobox container — kyuz0's rocm-7.2.3 image

**Critical:** use `rocm-7.2.3`, NOT the older `rocm-7rc-rocwmma`. The older
image ships HSA runtime 1.18.0 which segfaults during tensor upload on
gfx1151. The new image bundles a working HSA runtime and a pre-built
`llama-server` with the compiler unroll patch for the ROCm 7+ performance
regression.

```bash
distrobox create --name llama-rocm \
  --image docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.3 \
  --additional-flags "--device /dev/dri --device /dev/kfd --group-add video --group-add render --security-opt seccomp=unconfined"
```

**Bazzite-specific note:** do NOT add `--group-add sudo` (Ubuntu convention).
Fedora uses `wheel`, and distrobox doesn't need either anyway.

Verify GPU access and binary:

```bash
distrobox enter llama-rocm -- rocminfo | grep gfx1151
# → Name: gfx1151

distrobox enter llama-rocm -- which llama-server
# → /usr/local/bin/llama-server
```

If `rocminfo` shows no GPU, try recreating with `--additional-flags "--privileged"`.

**You do NOT need to build llama.cpp.** The kyuz0 image ships a pre-built
`llama-server` tuned for Strix Halo. Skipping the build saves ~15 minutes and
avoids version-mismatch problems.

---

## 3. Model fetch

```bash
mkdir -p ~/models
cd ~/models

# Bazzite usually has hf CLI pre-installed
# Note: huggingface-cli is deprecated, use hf

hf download lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF \
  --include "*Q4_K_M*" \
  --local-dir ~/models/qwen3-coder-30b
```

About 17 GB. Internal NVMe only — `--no-mmap` loads the full thing into GTT.

**Avoid these GGUFs:**
- Unsloth Dynamic 2.0 quants (UD-Q4_K_XL) for this model — tokenizer artifact
  triggers Llama-3-style token IDs that crash the loader
- The `Qwen3.6-35B-A3B` family — hybrid Transformer+Mamba; ROCm doesn't
  support Mamba SSM kernels yet (as of mid-2026)

Stick with the LM Studio Community quant. Pure transformer MoE, known good.

---

## 4. systemd user service

Use the reference unit at [`../systemd/llama-server-px13.service`](../systemd/llama-server-px13.service),
or write your own at `~/.config/systemd/user/llama-server.service`:

```ini
[Unit]
Description=llama.cpp server (Qwen3-Coder-30B for Claude Code)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/distrobox enter llama-rocm -- llama-server \
    -m /var/home/%u/models/qwen3-coder-30b/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf \
    --host 127.0.0.1 \
    --port 8080 \
    -ngl 999 \
    -c 131072 \
    --parallel 2 \
    -fa 1 \
    --no-mmap \
    --jinja \
    --temp 0.7 \
    --top-p 0.8 \
    --top-k 20
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

**Important flag notes (lessons learned):**

- `-c 131072` with `--parallel 2` gives 64K context per slot. Claude Code +
  claude-mem injects ~30-40K tokens at session start; at lower contexts you
  hit "request exceeds available context size" immediately.
- `-fa 1` (the integer, not `on` or just `-fa`) — kyuz0's tested syntax for
  flash attention with rocWMMA.
- `-ngl 999` — kyuz0 convention for "all layers to GPU". Works the same as
  `-ngl 99` for this 48-layer model.
- `--no-mmap` is mandatory on Strix Halo. With mmap, performance collapses
  above 64 GB allocation due to a ROCm issue.
- `--jinja` for proper tool-call template parsing. Without it, Claude Code's
  tool calls return malformed JSON.
- Default sampling params (`--temp 0.7 --top-p 0.8 --top-k 20`) are
  Qwen3-Coder's recommended values. Don't omit.

**Enable and start:**

```bash
systemctl --user daemon-reload
systemctl --user enable --now llama-server.service
sudo loginctl enable-linger $USER

journalctl --user -u llama-server -f
```

Wait for `server is listening on http://127.0.0.1:8080`. First load is ~5-10
seconds.

---

## 5. Smoke test

```bash
curl -s http://127.0.0.1:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-coder-30b",
    "max_tokens": 200,
    "messages": [{"role": "user", "content": "Write fizzbuzz in Python."}]
  }' | jq '.content[0].text'
```

Should return Python code within a few seconds.

---

## 6. Wire up Claude Code

Use the `claude-smart` wrapper from `bin/`. Three env vars are required; the
wrapper sets them per-session so they don't pollute your shell:

```bash
claude-smart --status     # check both backends
claude-smart --local      # force PX13 local
claude-smart --remote     # force Anthropic API
claude-smart              # auto: real API, fall back to local
```

---

## 7. Practical expectations

| Action | Time |
|---|---|
| `claude-smart --local` startup | 1-2 sec |
| First message in a session (cold prefill) | 90-120 sec |
| Follow-up messages, cached prefix | 5-25 sec |
| Generation streaming | 25-55 t/s |

**What works well:**
- Single-file edits, refactors, code explanation, test generation
- Standard Claude Code tool use (Read, Edit, Bash, Glob, Grep)
- MCP servers with flat tool calls (Notion, Beeper, FloorIQ)
- claude-mem integration — full project context loads on cold start

**What's harder:**
- Deeply nested JSON in MCP calls (occasional retry needed)
- Long autonomous agent sessions (thermal throttling on the laptop chassis)
- Vision input (this GGUF is text-only)

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `couldn't bind HTTP server socket` | Old llama-server still running | `pkill -f llama-server` |
| Silent SIGSEGV in `libhsa-runtime64.so.1.18.0` | Old broken container image | Recreate with `rocm-7.2.3` |
| "exceeds available context size" | `-c N --parallel P` divides N across P | Increase `-c` (use 131072 for 2 parallel) |
| Tool calls malformed | `--jinja` missing | Add to systemd unit |
| Model load OOM | `gttsize` karg didn't apply | Check `/proc/cmdline`, reboot |
| `</s>` warning during load | Harmless cosmetic noise | Ignore |
| `bash: brew: command not found` on container entry | Toolbox rc cosmetic | Ignore or comment out in container's `~/.bashrc` |
| tg drops below 20 t/s | Thermal throttle | Plug in, performance profile, lift back of laptop |

---

## 9. What we ruled out (so you don't waste time)

These were investigated and are NOT typical causes of gfx1151 segfaults:

- The `</s>` control-token warning — harmless cosmetic logging
- The Unsloth Dynamic 2.0 quants — fail for Qwen3-Coder-30B specifically,
  but the file format itself is valid
- Bleeding-edge llama.cpp master vs. older releases — the build version
  isn't the issue when using kyuz0's pre-built binary
- Kernel < 6.18.4 — only relevant if you're actually on an old kernel
- linux-firmware-20251125 — only relevant if you're on that exact bad version

The actual cause in 95% of cases: **stale toolbox image**. Switch to
`rocm-7.2.3` and move on.

---

## 10. Cleanup

```bash
# Stop server
systemctl --user stop llama-server.service

# Check GPU memory usage
cat /sys/class/drm/card1/device/mem_info_gtt_used

# Remove a model
rm -rf ~/models/<model-name>

# Clean hf cache duplicates (can reclaim 20+ GB)
hf cache scan
hf cache delete
```
