# Zenbook Duo (Core Ultra 9, 32 GB) — Bazzite Setup

Companion setup to the PX13 runbook for a **CPU-class machine without a real
GPU accelerator**. The Zenbook Duo has an Intel Core Ultra 9 185H with Arc
integrated graphics — useful for graphics but not competitive with discrete
GPUs or AMD APUs for LLM workloads.

**Three options for this machine, ordered by what you should actually use:**

1. **[Tailscale bridge to PX13](TAILSCALE-BRIDGE.md)** — recommended for daily use.
   Full 30B perf from anywhere with internet.
2. **Local CPU inference** — covered here. Offline-capable backup, ~6-10 t/s gen.
3. **Real Anthropic API via plain `claude`** — when online and not API-down.

This doc covers option 2 — the "I'm on a plane and the Anthropic API is also
down somehow" tier. Now actually *usable* (not just technically functional)
thanks to picking the right model.

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

## The model: DeepSeek-Coder-V2-Lite-Instruct (16B MoE)

After testing several options, this is what works for the Duo:

| Property | Value | Why it matters |
|---|---|---|
| Total params | 15.7B | Fits in 32 GB RAM at Q4 |
| Active params (MoE) | 2.4B | Generation speed comparable to a 2-3B dense model |
| Native context | 160K | Easily fits Claude Code's ~50K context injection |
| Quantization | Q4_K_M | ~10 GB on disk, ~21 GB total runtime |
| License | Custom (research/commercial OK with attribution) | Suitable for Enhance Tech use |

**Why not Qwen2.5-Coder-7B?** It's smaller (4.4 GB) and slightly faster, but
its 32K native context is *below* Claude Code + claude-mem's ~50K injection.
First message fails with "request exceeds available context size" 100% of
the time. Qwen2.5-Coder-14B has the same 32K ceiling.

**Why not Qwen3-Coder-30B?** 17 GB Q4, 256K context — perfect on paper, but
its dense generation on CPU lands around 2-3 t/s. Painfully slow.
DeepSeek-Coder-V2-Lite's MoE sparsity gets you 3x that speed at comparable
quality.

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

## 2. Model fetch

```bash
mkdir -p ~/models/deepseek-coder-v2-lite

hf download bartowski/DeepSeek-Coder-V2-Lite-Instruct-GGUF \
  --include "*Q4_K_M*" \
  --local-dir ~/models/deepseek-coder-v2-lite
```

About 10 GB. Verify when done:

```bash
ls -lh ~/models/deepseek-coder-v2-lite/
```

You should see `DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf` (~10 GB). If
the filename differs slightly (Bartowski occasionally adjusts), note it
exactly — you'll need it in the systemd unit.

---

## 3. The container — official llama.cpp prebuilt server image

**Skip the build-from-source path.** Use the official prebuilt image instead.
It's maintained by the llama.cpp team, tracks master HEAD, ships with the
`/v1/messages` Anthropic Messages API endpoint, and includes optimizations
for x86 CPUs out of the box.

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
  -m /models/deepseek-coder-v2-lite/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf \
  --host 0.0.0.0 --port 8080 \
  --alias deepseek-coder-v2-lite \
  -c 65536 --parallel 1 -t 16 --jinja
```

**Critical flag: `:z` on the volume mount.** Bazzite uses SELinux. Without
`:z`, the container can't read the model file (you'll get "Permission denied"
in the logs). The `:z` tells podman to relabel the directory for shared
container access.

Watch for these in the logs:
- `n_ctx_train (163840)` — confirms 160K native context
- `projected to use 21821 MiB of host memory` — ~21 GB total footprint
- `server is listening on http://0.0.0.0:8080` — the win condition

Smoke test from another terminal:

```bash
curl -s http://127.0.0.1:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-coder-v2-lite","max_tokens":80,"messages":[{"role":"user","content":"Write a python function to reverse a string."}]}' \
  | jq
```

Should return clean Anthropic-format JSON with Python code. Then `Ctrl+C` the
foreground run.

---

## 4. systemd user service

Use the reference unit at [`../systemd/llama-server-duo.service`](../systemd/llama-server-duo.service),
or write your own at `~/.config/systemd/user/llama-server.service`.

**Important**: do NOT use multi-line `ExecStart` with backslash continuations.
A single trailing space after any `\` will break systemd parsing and you'll
get `error: invalid argument: \` failures. Use one long line:

```ini
[Unit]
Description=llama.cpp server (DeepSeek-Coder-V2-Lite-16B for Claude Code, CPU prebuilt)
After=network.target

[Service]
Type=simple
ExecStartPre=-/usr/bin/podman rm -f llama-server
ExecStart=/usr/bin/podman run --rm --name llama-server -p 127.0.0.1:8080:8080 -v /var/home/%u/models:/models:z ghcr.io/ggml-org/llama.cpp:server -m /models/deepseek-coder-v2-lite/DeepSeek-Coder-V2-Lite-Instruct-Q4_K_M.gguf --host 0.0.0.0 --port 8080 --alias deepseek-coder-v2-lite --parallel 1 -c 65536 -t 16 --jinja
ExecStop=/usr/bin/podman stop -t 5 llama-server
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

**Important flag notes:**

- `ExecStartPre=-/usr/bin/podman rm -f llama-server` — cleans up any stale
  container before starting. Leading `-` ignores errors if there's nothing to
  remove.
- `ExecStop=/usr/bin/podman stop -t 5 llama-server` — ensures the container
  actually stops on `systemctl stop`, not just orphaned.
- `--parallel 1` — single slot, full 64K context per session. CPU speed
  doesn't have throughput to spare for concurrent sessions anyway.
- `-c 65536` — 64K context. Plenty for Claude Code's ~50K injection.
- `-t 16` — 16 threads. Core Ultra 9 has 22 logical cores but inference tops
  out around 12-16 threads; more = contention.
- `--jinja` — required for tool-call parsing. Without it, Claude Code's tool
  calls return malformed.
- `--host 0.0.0.0` inside container, but `-p 127.0.0.1:8080:8080` in podman
  means it only listens on localhost from the host's perspective.

**Don't enable autostart** if you prefer manual control over memory:

```bash
systemctl --user daemon-reload
# Note: start, not enable --now
systemctl --user start llama-server.service
```

`claude-smart` will lazy-start the service on first `--local` invocation.

---

## 5. Wire up Claude Code

Edit `~/.local/bin/claude-smart` to point at this model:

```bash
sed -i 's/LOCAL_MODEL=.*/LOCAL_MODEL="deepseek-coder-v2-lite"/' ~/.local/bin/claude-smart
```

Verify:

```bash
grep LOCAL_MODEL ~/.local/bin/claude-smart
```

Then:

```bash
claude-smart --status
# Should show:
#   Anthropic API:  up
#   Local:          up @ http://127.0.0.1:8080

cd ~/some-project
claude-smart --local
```

---

## 6. Realistic performance expectations

Measured on Duo with Core Ultra 9 185H, 32 GB RAM, this exact config:

| Action | Time |
|---|---|
| `claude-smart --local` startup | 1-2 sec |
| Model load (if service was stopped) | 30-60 sec |
| First message cold prefill (~50K tokens) | 5-10 min |
| Follow-up messages with cache hit | 30-90 sec |
| Generation streaming | 6-10 t/s |
| GPU memory | n/a (CPU only) |
| System memory used | ~21 GB |

**Be honest about the use case:**

- ✅ Single-file edits, refactors, code explanation
- ✅ Standard Claude Code tool use (Read, Edit, Bash, Glob, Grep)
- ✅ Quick code questions
- ✅ Truly offline scenarios (flights, conferences with no wifi)
- ⚠️ Long agentic Claude Code sessions are slow but possible
- ❌ Multi-file deep refactoring across many files in one session
- ❌ Real production work — use real `claude` or PX13 via Tailscale

**For this machine, prioritize:**

1. Real Claude API when online (primary)
2. Tailscale to PX13 when reachable (full 30B at PX13 speeds)
3. This local 16B MoE only when both above fail

See [`TAILSCALE-BRIDGE.md`](TAILSCALE-BRIDGE.md) for option 2.

---

## 7. Heat & battery

CPU inference pegs ~16 cores at 100% for prefill + generation duration.

- **Plugged in**: fans loud, chassis warm, ~50-65 W package power
- **On battery**: thermal throttle within minutes, battery drains in
  ~30-45 min under sustained load

This is a planned-burst tool — fire off a query, get an answer, let it cool.
Don't sit on it doing autonomous agent work.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Port 8080 already in use | Old llama-server still running | `systemctl --user stop llama-server.service`, `pkill -f llama-server`, `podman rm -f llama-server` |
| Container can't read model | SELinux blocking volume mount | Add `:z` to the volume spec: `-v /path:/models:z` |
| `error: invalid argument: \` | Trailing whitespace in systemd ExecStart line continuation | Use one long ExecStart line, no `\` continuations |
| OOM during load | RAM contention with browser/IDE | Close apps, model needs ~21 GB total |
| Tool calls malformed | `--jinja` missing | Add to systemd unit, restart |
| Context overflow on first message | Different model with smaller native context | This setup uses DeepSeek-Coder-V2-Lite (160K). If you swapped to a 32K model, that's the cause. |
| `</s>` warning on load | Harmless cosmetic noise | Ignore |
| 404 on `/v1/messages` | Build of llama.cpp predates Anthropic endpoint | Use the official prebuilt `ghcr.io/ggml-org/llama.cpp:server` image, not a hand-built binary |

---

## 9. Why we ended up here (lessons learned)

This doc is the third revision. Earlier attempts taught us:

**Build-from-source on master HEAD doesn't always have `/v1/messages`.**
We rebuilt at `b6014` (the version we used on PX13) and the Anthropic endpoint
still wasn't there. The endpoint is reliably available in the official
prebuilt `ghcr.io/ggml-org/llama.cpp:server` image, which tracks master HEAD
and ships the feature compiled in. Use the prebuilt image.

**Qwen2.5-Coder-7B's 32K native context is too small for Claude Code.**
Combined with claude-mem's context injection (~30-55K tokens at session start),
first message always fails with "request exceeds available context size".
DeepSeek-Coder-V2-Lite's 160K native context is the actual minimum viable.

**MoE models are the right call for CPU.** A 2.4B-active MoE generates at
roughly the speed of a 2-3B dense model, while having the knowledge breadth
of a much larger model. DeepSeek-Coder-V2-Lite hits this sweet spot for CPU
inference.

**SELinux blocks podman volume mounts on Bazzite without `:z`.** Symptom is
"Permission denied" reading the model file. Trivial fix once you know.

**Multi-line `ExecStart` in systemd units is fragile.** Any trailing
whitespace on a `\` continuation breaks parsing with `error: invalid
argument: \`. Use one long line.

---

**Maintained by:** Leandro Sanchez, Enhance Tech.
