# Day 1 War Stories — Zenbook Duo Inference Testing

*A chronological account of the session that ended with Aider + Qwen2.5-Coder-3B + Vulkan.*

This journal captures the investigative journey so future readers don't repeat
it. The main docs are the conclusion; this is how we got there.

---

## The starting point

The Duo already had a working llama-server setup described in ZENBOOK-DUO.md
— except the recommended model (DeepSeek-Coder-V2-Lite) had problems that
weren't caught in initial testing. Those tests only verified the model loaded
and returned a response; they didn't test real agentic use.

Goal: get reliable agentic coding assistance working on the Duo when offline
or when the Anthropic API is down.

---

## Attempt 1: DeepSeek-Coder-V2-Lite-Instruct (16B MoE)

The existing setup. On paper: 160K context (enough for Claude Code), 10 GB
(fits in 32 GB RAM), MoE architecture so generation is faster than a dense
16B.

In practice:

- When asked to "monitor beeper messages every 90 seconds", the model invented
  a `loop` function that doesn't exist in Claude Code.
- Raw `<|tool_calls_begin|>` tokens leaked into chat output — the model was
  trained on the raw template format, not the interpreted output.
- Responded with "I'm an AI and can't perform tasks on your behalf" even with
  system prompt reinforcement.

**Verdict**: Coder-trained, not agentic-trained. Technically functional for
Q&A but unreliable for tool use. Avoid.

---

## Attempt 2: Qwen2.5-Coder-7B Q4_K_M

Smaller, faster, well-reviewed for coding tasks.

32K native context. Claude Code + claude-mem injects ~30-55K tokens on first
message. First message failed 100% of the time:

```
error: context size exceeded
```

**Verdict**: Context wall. No fix possible without switching models.

Same verdict for Qwen2.5-Coder-14B — same 32K ceiling, just slower.

---

## Attempt 3: Qwen3.5-9B Q4_K_XL

128K context, agentic-trained, newer architecture. Looked promising.

Prefill speed: 24 t/s. At 50K tokens: 35 minutes of prefill before the first
token generates. Claude Code's internal timeout fires at ~10-12 minutes,
cancels the request, retries, gets a partial cache hit (~5-30% overlap),
restarts prefill from the cache boundary, times out again — infinite loop.
The model never generates output.

```
W srv next: stopping wait for next result due to should_stop condition
W srv next: ref: https://github.com/ggml-org/llama.cpp/pull/22907
W srv stop: cancel task, id_task = N
```

Setting `ANTHROPIC_API_TIMEOUT_MS=3600000` (1 hour) had zero effect. The
timeout is baked into Claude Code's request lifecycle, not the HTTP client.

**Verdict**: Too slow on CPU. The timeout is not configurable from outside.

---

## Attempt 4: Qwen3.5-4B Q4_K_XL

Half the size, hopefully double the prefill speed. 37 t/s prefill (measured).
At 50K tokens: ~22 minutes. Still longer than the 10-12 minute timeout.

Same failure mode. Same log pattern.

**Verdict**: Still times out. The timeout wall is fundamental, not a model
tuning problem.

---

## Attempt 5: Qwen3.5-0.8B Q4_K_XL

Sub-gigabyte model. Prefill at 200 t/s — fast enough to beat the timeout for
50K tokens in theory (~4 minutes).

First message completes. But Claude Code re-injects context on every turn,
and 0.8B quality is too low for reliable tool use — malformed JSON for tool
calls, hallucinated function names, frequent refusals.

**Verdict**: Fast enough on prefill, but too small for reliable agentic use.
Not a real solution.

---

## The insight: Claude Code's context is the problem, not the model

The pattern across all attempts was the same:

- Claude Code injects 30-55K tokens of context on first message (system
  prompt ~15-25K + claude-mem injection ~10-20K + tools list)
- CPU prefill at any realistic speed can't beat the 10-12 minute internal
  timeout for that context size
- Increasing timeout via env var does nothing — it's the wrong layer
- No model swap fixes this — it's architectural

The right fix: use a tool that injects less context.

---

## The intermediate solution: Aider + Qwen3.5-4B on CPU

Aider comparison at this stage:

| | Claude Code | Aider |
|---|---|---|
| System prompt | ~15-25K tokens | ~3-5K tokens |
| Memory injection | +10-20K (claude-mem) | None |
| File context | Agent discovers automatically | User `/add`s explicitly |
| First-message total | 30-55K tokens | 5-10K tokens |
| Cold prefill at 37 t/s (CPU) | 14-25 min | 2-4 min |
| Internal timeout | ~10-12 min (hard) | None |

First real test with Aider + Qwen3.5-4B on CPU: worked on first try. Cold
start in 2 minutes, follow-up in 45 seconds, diff format applied correctly.

Trade-off: less autonomy. You tell Aider which files to load; Claude Code
discovers them itself. But "actually finishes" beats "autonomously hangs"
every time.

Good enough — but it turned out the Arc iGPU could do much better.

---

## Attempt 6: Vulkan on Arc iGPU

With Aider confirmed working, the question became: can the Arc iGPU speed
things up? The CPU setup was functional but cold starts were 2-4 minutes.

Tried the plain `:server` image first with `-ngl 999` and `--device /dev/dri`.
Server started, model loaded, but prefill was still 24-37 t/s — same as CPU.
The plain `:server` image has no Vulkan compiled in. It runs CPU regardless
of flags.

Switched to `ghcr.io/ggml-org/llama.cpp:server-vulkan` — a completely
different image. Added `--device /dev/dri -ngl 999`. Startup logs changed:

```
ggml_vulkan: Found 1 Vulkan devices
Vulkan0 : Intel(R) Arc(tm) Graphics (MTL) (23576 MiB, 20354 MiB free)
```

The iGPU was reporting ~23 GB of addressable memory — because Meteor Lake's
unified memory lets the GPU address most of system RAM. Not what was expected.

Prefill speed with Qwen3.5-4B on Vulkan: ~120 t/s. Better, but the hybrid
attention architecture (Gated DeltaNet) in Qwen3.5 was causing cache
invalidation every turn — the server was re-prefilling from scratch on each
Aider message instead of reusing the KV cache. That ate the speed gain.

Switched to Qwen2.5-Coder-3B (standard multi-head attention). Cache reuse
worked immediately. Prefill hit 260 t/s on a 4K-token cold start. Total time
for first Aider response: ~25 seconds.

**This was the real solution:**

| Model | Backend | Prefill | Gen | Cold start | Notes |
|---|---|---|---|---|---|
| Qwen3.5-4B | CPU | 37 t/s | 10 t/s | 2-4 min | Functional |
| Qwen3.5-4B | Vulkan | ~120 t/s | ~10 t/s | ~1 min | Cache invalidation kills it |
| Qwen2.5-Coder-3B | Vulkan | ~260 t/s | ~12 t/s | ~25 sec | ✅ Daily driver |

---

## Lessons extracted

1. **CPU/iGPU prefill speed × context size × tool timeout = hard constraint.**
   Don't try to break it; route around it. Use a tool with smaller context
   injection (Aider, not Claude Code).

2. **Coder models ≠ agentic models.** DeepSeek-Coder-V2-Lite is trained for
   code completion, not tool-call execution. It hallucinates the API surface.

3. **Claude Code's timeout is not HTTP-level.** `ANTHROPIC_API_TIMEOUT_MS`
   only affects the HTTP client. The request lifecycle timeout is internal to
   Claude Code and cannot be extended from outside.

4. **Use `server-vulkan`, not `server`.** Two distinct images. The plain
   `:server` tag runs on CPU regardless of `-ngl` or `--device` flags.

5. **Pass `--device /dev/dri` to podman.** Without it, the container can't
   see the iGPU and silently runs on CPU. No warning in the logs.

6. **Qwen3.5 hybrid attention breaks KV cache reuse.** The Gated DeltaNet
   architecture causes llama.cpp to invalidate and re-prefill the KV cache
   every turn. Defeats the prefill speedup. Use standard-attention models
   (Qwen2.5, Llama) for Aider on iGPU.

7. **Qwen3.5 requires `--reasoning off` for CLI use.** Without it, the model
   emits `<think>...</think>` blocks before every response. Aider doesn't
   expect them. (Moot if you avoid Qwen3.5 entirely, but worth knowing.)

8. **Intel Arc iGPU can address ~23 GB of unified memory.** Don't assume
   iGPU means memory-constrained. Bigger models fit than expected.

9. **Direct podman is simpler than distrobox for server workloads.** Distrobox
   is designed for interactive containers. A server is a server; use podman.

10. **SELinux `:z` flag is not optional on Bazzite.** The container silently
    fails to read the model file without it — "Permission denied" in the logs
    even though the host user owns the file.

11. **Multi-line systemd `ExecStart` with `\` is fragile.** One trailing space
    after a `\` breaks the unit with `error: invalid argument: \`.
    Use one long line.

---

*Written after the testing session, May 16, 2026.*
