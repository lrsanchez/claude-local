# Intel Arc iGPU Vulkan Notes — Zenbook Duo (Meteor Lake)

Non-obvious findings from running llama.cpp on Intel Arc integrated graphics
via Vulkan on a Zenbook Duo (Core Ultra 9 185H, 32 GB). Future readers will
need these — they aren't in the official docs.

---

## 1. Use the `server-vulkan` image, NOT plain `server`

```
✓ ghcr.io/ggml-org/llama.cpp:server-vulkan    (Vulkan compiled in)
✗ ghcr.io/ggml-org/llama.cpp:server           (CPU only)
```

These are two distinct images. The plain `:server` tag runs on CPU regardless
of what flags you pass — even with `-ngl 999`. Use `:server-vulkan` explicitly.

Pull it:

```bash
podman pull ghcr.io/ggml-org/llama.cpp:server-vulkan
```

---

## 2. Pass `--device /dev/dri` to podman

Without this flag, the container cannot see the iGPU. Vulkan silently falls
back to CPU and you'll wonder why it's slow.

```
✓ podman run ... --device /dev/dri ...
✗ podman run ...                         (no GPU access)
```

There's no warning in the logs when this is missing — the server starts
normally on CPU. Only the token speed reveals the problem. See
[Verify Vulkan is actually engaged](#9-verify-vulkan-is-actually-engaged).

---

## 3. Add `-ngl 999` to offload all layers to GPU

`-ngl 999` instructs llama.cpp to offload all model layers to the GPU.
Without it, the model runs on CPU even when Vulkan is detected and
`--device /dev/dri` is passed. `999` means "more than any model has" — a
sentinel for "all layers."

---

## 4. Intel Arc iGPU on Meteor Lake reports ~23 GB addressable "VRAM"

When Vulkan initializes on the Arc iGPU in a 32 GB Duo, llama.cpp reports
something like:

```
ggml_vulkan: Found 1 Vulkan devices
Vulkan0 : Intel(R) Arc(tm) Graphics (MTL) (23576 MiB, 20354 MiB free)
```

That ~23 GB figure is not a bug. On Meteor Lake's unified memory architecture,
the iGPU can address most of system RAM as GPU memory. This is much more than
you'd expect from a laptop iGPU.

Practical implication: 8B+ models with large contexts fit comfortably in
"VRAM." Don't assume Intel iGPUs are memory-constrained the way older discrete
laptop GPUs were.

---

## 5. Vulkan silently ignores YaRN context extension flags

If you try to push context past the model's native ceiling with:

```
--rope-scaling yarn --rope-scale 2 --yarn-orig-ctx 32768
```

The Vulkan backend parses the flags without error but caps at the model's
native context anyway. The extension has no effect.

Workaround: choose a model with sufficient NATIVE context for your use case.
Qwen2.5-Coder-3B's 32K native is plenty for Aider (which injects ~5-10K). It
would have been too small for Claude Code (which injects 30-55K) — but that's
ruled out on Duo hardware for other reasons anyway.

---

## 6. Prefill speed is fast; generation is moderate

Real measurements on Arc iGPU + Vulkan, Qwen2.5-Coder-3B:

| Phase | Speed | Why |
|---|---|---|
| Prefill | 200–365 t/s | Compute-bound, GPU excels |
| Generation | 10–15 t/s | Memory-bandwidth-bound, iGPU shares DDR5 with CPU |

Prefill is where the GPU shines — it parallelizes the KV cache fill across
thousands of SIMD units. Generation is memory-bandwidth-limited regardless of
GPU class when the KV cache is in system RAM.

Net effect for users: cold starts feel fast, token streaming feels normal.
A 4K-token Aider turn lands in ~25 seconds total (prefill + gen).

---

## 7. Bigger models show prefill deceleration on iGPU

| Model | Context | Prefill speed |
|---|---|---|
| Qwen2.5-Coder-3B Q4_K_M | 4K tokens | ~260 t/s |
| Llama-3.1-8B-Instruct | 4K tokens | ~155 t/s |
| Llama-3.1-8B-Instruct | 6K tokens | ~92 t/s (decelerating) |

The iGPU shows diminishing returns as KV cache grows because more data moves
through the shared memory bus. Smaller models maintain throughput much better.

For Duo daily use, prefer 3–4B models over 7–8B even when memory allows the
larger model. You get better throughput and Aider doesn't need the extra
capacity.

---

## 8. SELinux still requires `:z` on volume mounts

Same requirement as any podman setup on Bazzite. Mount the model directory
with `:z`:

```
-v /var/home/leandro/models:/models:z
```

Without `:z`, podman doesn't relabel the directory for `container_file_t`
access and the container gets "Permission denied" trying to read the GGUF file,
even though the host user owns it:

```
gguf_init_from_file: failed to open GGUF file '...' (Permission denied)
```

The `:z` relabel is one-time per container; subsequent runs of the same image
against the same path are no-ops.

---

## 9. Verify Vulkan is actually engaged

Don't assume that adding `--device /dev/dri -ngl 999` worked. Check the
startup logs:

```bash
journalctl --user -u llama-server --since "5 minutes ago" --no-pager \
  | grep -iE "vulkan|ggml_vulkan"
```

Expected output on working setup:

```
ggml_vulkan: Found 1 Vulkan devices
Vulkan0 : Intel(R) Arc(tm) Graphics (MTL) (23576 MiB, 20354 MiB free)
```

If those lines are absent, one of these is misconfigured:
- Wrong image tag (plain `:server` instead of `:server-vulkan`)
- Missing `--device /dev/dri`
- Missing `-ngl 999`

Simpler heuristic: run a small request and check the token speed. If prefill
is 200+ t/s, Vulkan is working. If it's 25–40 t/s, you're on CPU.

---

## 10. Confirm iGPU is busy during inference

```bash
sudo dnf install -y intel-gpu-tools
sudo intel_gpu_top
```

During an active inference request, the render/compute engines should be near
100%. If they're idle while your CPU cores are pegged, Vulkan offload isn't
working despite what the startup logs claim.

---

**See also:** [`ZENBOOK-DUO.md`](ZENBOOK-DUO.md) for the full server setup,
and [`JOURNAL.md`](JOURNAL.md) for the investigative history that produced
these findings.
