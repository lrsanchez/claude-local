# Zenbook Duo (Core Ultra 9, 32 GB) — Bazzite Setup

Companion setup to the PX13 runbook for a **CPU-class machine without a real
GPU accelerator**. The Zenbook Duo has an Intel Core Ultra 9 (Meteor/Lunar
Lake) with Arc integrated graphics — useful for graphics but not competitive
with discrete GPUs or AMD APUs for LLM workloads in 2026.

**Three options for this machine, ordered by what you should actually use:**

1. **[Tailscale bridge to PX13](TAILSCALE-BRIDGE.md)** — recommended.
   Full 30B perf from anywhere with internet.
2. **Local CPU inference** — covered here. Smaller model (7B), CPU-only.
   Slow but truly offline.
3. **Real Anthropic API via plain `claude`** — when online and not API-down.

This doc covers option 2 — the "I'm on a plane and the Anthropic API is also
down somehow" tier.

---

## Hardware realities

- 32 GB RAM (vs PX13's 128 GB unified)
- Intel Arc iGPU shares system memory but Vulkan inference on Intel is hit-or-miss
- CPU inference on Core Ultra 9 with AVX-512 is actually decent — that's the path
- Battery drains in ~45 min under sustained CPU inference; plug in

**The right model class:** 7B-14B at Q4. Not the 30B you run on PX13. A 30B
model at Q4 needs ~17 GB just for weights, and on CPU you'd see ~3-5 t/s —
unusable for interactive Claude Code.

---

## Recommended models

### Primary: Qwen2.5-Coder-7B-Instruct (~4.4 GB Q4)

The sweet spot for a 32 GB CPU laptop. Specifically coding-tuned, supports
tool calling, ~12-20 t/s on a Core Ultra 9.

```bash
hf download bartowski/Qwen2.5-Coder-7B-Instruct-GGUF \
  --include "*Q4_K_M*" \
  --local-dir ~/models/qwen2.5-coder-7b
```

### Patient option: Qwen2.5-Coder-14B-Instruct (~8.4 GB Q4)

Smarter, slower. ~5-10 t/s on CPU. Worth it if you have patience and want
better code quality on harder problems.

```bash
hf download bartowski/Qwen2.5-Coder-14B-Instruct-GGUF \
  --include "*Q4_K_M*" \
  --local-dir ~/models/qwen2.5-coder-14b
```

### Don't try

- Anything 30B+ on CPU (too slow for interactive use)
- The Qwen3-Coder family on Intel Arc via Vulkan (immature stack)
- Qwen3.6-35B-A3B (hybrid Mamba, no CPU implementation worth using)

---

## 1. Bazzite setup

No special kargs needed — CPU inference doesn't care about GTT.

Confirm AVX-512 is available on your specific Core Ultra variant:

```bash
grep -o "avx512[^ ]*" /proc/cpuinfo | sort -u
# Should show: avx512f, avx512vnni, avx512bf16, etc.
```

If `avx512f` is missing, you have a different CPU than expected — adjust
build flags below accordingly (`-DGGML_AVX2=ON` minimum).

---

## 2. Distrobox container — minimal Fedora toolbox

```bash
distrobox create --name llama-cpu \
  --image quay.io/toolbx/fedora-toolbox:43

distrobox enter llama-cpu
sudo dnf install -y git cmake gcc gcc-c++ make libcurl-devel
exit
```

---

## 3. Build llama.cpp for CPU with AVX-512

```bash
distrobox enter llama-cpu

cd ~
git clone https://github.com/ggml-org/llama.cpp.git
cd llama.cpp

cmake -B build -S . \
  -DGGML_NATIVE=ON \
  -DGGML_AVX512=ON \
  -DGGML_AVX512_VBMI=ON \
  -DGGML_AVX512_VNNI=ON \
  -DGGML_AVX512_BF16=ON \
  -DCMAKE_BUILD_TYPE=Release

cmake --build build --config Release -j$(nproc)
exit
```

`-DGGML_NATIVE=ON` lets the compiler pick the best instructions available on
the host CPU. The explicit AVX-512 flags ensure llama.cpp builds with the
fastest paths for your chip.

Build takes ~10 minutes.

---

## 4. systemd user service

Use the reference unit at [`../systemd/llama-server-duo.service`](../systemd/llama-server-duo.service),
or write your own at `~/.config/systemd/user/llama-server.service`:

```ini
[Unit]
Description=llama.cpp server (Qwen2.5-Coder-7B for Claude Code, CPU)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/distrobox enter llama-cpu -- \
    /var/home/%u/llama.cpp/build/bin/llama-server \
    -m /var/home/%u/models/qwen2.5-coder-7b/Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf \
    --host 127.0.0.1 \
    --port 8080 \
    -c 32768 \
    --parallel 1 \
    -t 16 \
    --jinja \
    --temp 0.7 \
    --top-p 0.8 \
    --top-k 20
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

**Key differences from PX13 setup:**

- No `-ngl` — CPU inference, no GPU offload
- No `-fa` — flash attention is GPU-only in llama.cpp
- No `--no-mmap` — CPU benefits from mmap for paging
- `-t 16` — Core Ultra 9 has 24 cores (8P + 16E) but inference tops out
  around 12-16 threads; more = contention. Tune for your specific SKU.
- `-c 32768` with `--parallel 1` = full 32K context per session
- One parallel slot — CPU speed doesn't have throughput to spare for
  concurrent sessions

Enable and start:

```bash
systemctl --user daemon-reload
systemctl --user enable --now llama-server.service
sudo loginctl enable-linger $USER
```

First load takes 20-40 seconds (paging 4.4 GB into RAM).

---

## 5. Wire up Claude Code

Edit `~/.local/bin/claude-smart` on this machine to update the model name:

```bash
LOCAL_MODEL="qwen2.5-coder-7b"
```

Then use as normal:

```bash
claude-smart --local
```

---

## 6. Realistic performance expectations

| Action | Time on Zenbook Duo CPU |
|---|---|
| Model load | 20-40 sec |
| First message (cold prefill of ~30K tokens) | 4-8 min |
| Follow-up messages | 30-90 sec |
| Generation streaming | 12-20 t/s (Qwen2.5-Coder-7B) |

**Be honest about the use case:**

- ✅ Quick code questions
- ✅ Single-function generation
- ✅ Explanation of error messages
- ✅ Boilerplate generation
- ✅ Truly offline scenarios (flights, conferences with no wifi)
- ❌ Long agentic Claude Code sessions
- ❌ Multi-file refactoring
- ❌ Anything that requires reading >5 files

**For this machine, prioritize:**

1. Real Claude API when online (primary)
2. Tailscale to PX13 when reachable (snappy 30B over Tailscale)
3. This local 7B only when both above fail

See [`TAILSCALE-BRIDGE.md`](TAILSCALE-BRIDGE.md) for option 2.

---

## 7. Heat & battery

CPU inference pegs all cores at 100% for prefill + generation duration.

- **Plugged in**: fans loud, chassis warm but fine, ~45 W package power
- **On battery**: thermal throttle within minutes, battery drains in ~45 min
  under sustained load

This is a planned-burst tool — fire off a query, get an answer, let it cool.
Don't sit on it doing autonomous agent work.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| OOM during load | RAM contention with browser/IDE | Close apps, model is ~4.4 GB |
| Generation < 5 t/s | Too many threads | Drop `-t 16` to `-t 12` or `-t 8` |
| First message hangs forever | CPU prefill at 30K tokens is slow | Wait it out, or disable some MCPs |
| Tool calls malformed | `--jinja` missing | Add to systemd unit |
| Fan at 100% | Normal during inference | Accept it, plug in, or use PX13 over Tailscale |

---

## 9. Why not the Intel Arc iGPU?

Intel Arc on Core Ultra has Vulkan compute, and llama.cpp's Vulkan backend
works on it. In practice:

- Vulkan on Intel iGPU gets ~30-50% of CPU performance for most models
- Driver stability on Linux for LLM workloads is variable
- VRAM is shared system memory anyway, so no real memory advantage

Worth trying if you want to tinker:

```bash
cmake -B build -S . \
  -DGGML_VULKAN=ON \
  -DCMAKE_BUILD_TYPE=Release
```

For Intel-class hardware in 2026, CPU with AVX-512 is the pragmatic path.
