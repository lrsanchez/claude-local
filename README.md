# claude-local

Local Claude Code backup setups for AMD Strix Halo and Intel Core Ultra laptops
running Bazzite (Fedora Atomic). Built around llama.cpp's native Anthropic
Messages API — no proxies, no router middleware.

When the Anthropic API is down, rate-limited, or you're offline, `claude-smart
--local` hands off to a local model with the same Claude Code experience.

## Tested hardware

| Machine | CPU/GPU | RAM | Model | Tokens/sec |
|---|---|---|---|---|
| ASUS ProArt PX13 | Ryzen AI Max+ 395 / Radeon 8060S (gfx1151) | 128 GB unified | Qwen3-Coder-30B-A3B Q4_K_M | 319 prefill / 26 gen |
| ASUS Zenbook Duo | Core Ultra 9 (Meteor/Lunar Lake) / Arc iGPU | 32 GB | Qwen2.5-Coder-7B Q4_K_M | CPU: 12-20 gen |

Both machines run Bazzite. Setup details per machine in [`docs/`](docs/).

## Quick start

1. Pick your hardware guide:
   - **[PX13 (Strix Halo)](docs/PX13-BAZZITE.md)** — primary, full-power setup
   - **[Zenbook Duo (CPU-only)](docs/ZENBOOK-DUO.md)** — lightweight backup
   - **[Tailscale bridge](docs/TAILSCALE-BRIDGE.md)** — point the Duo at the PX13 over Tailscale, get full 30B perf anywhere

2. Walk through kernel args, distrobox container, model download per your hardware doc

3. Run the installer:
   ```bash
   ./install.sh
   ```

4. Start the service and use it:
   ```bash
   systemctl --user enable --now llama-server.service
   claude-smart --local
   ```

## Log Viewer Application

A new log viewer application has been added to provide better monitoring of your LLaMA server:

### Features:
- Real-time logs from `journalctl --user -u llama-server -f`
- Tabbed interface for easy navigation:
  - **Logs**: System logs from your LLaMA server
  - **Slots**: Detailed, formatted slot information with status and parameters
  - **Health**: Organized health status information including memory, GPU, model, and system details

### Usage:
1. Start the log viewer:
   ```bash
   npm start
   ```
2. Open your browser and navigate to `http://localhost:4000`
3. Use the tabs to view different information sources

The application automatically formats JSON responses from the `/slots` and `/health` endpoints for better readability, showing:
- Slot ID, context size, and processing status
- Key parameters and next token information
- Memory, GPU, model, and system health details

## What's in this repo

```
claude-local/
├── README.md                       ← this file
├── install.sh                      ← idempotent installer
├── bin/
│   └── claude-smart                ← the wrapper script
├── docs/
│   ├── PX13-BAZZITE.md             ← Strix Halo / Radeon 8060S setup
│   ├── ZENBOOK-DUO.md              ← Core Ultra 9 / CPU setup
│   └── TAILSCALE-BRIDGE.md         ← remote-access pattern
├── systemd/
│   ├── llama-server-px13.service   ← reference systemd unit for PX13
│   └── llama-server-duo.service    ← reference systemd unit for Duo
├── log-viewer.js                   ← Node.js log viewer application
├── index.html                      ← Web interface for the log viewer
├── package.json                    ← Application dependencies
├── LICENSE                         ← MIT
└── CONTRIBUTING.md                 ← if you want to upstream changes
```

## How it works

```
┌─────────────┐     claude              ┌─────────────────┐
│ your shell  │ ──────────────────────► │ Anthropic API   │
│             │                          └─────────────────┘
│             │     claude-smart
│             │ ──────────┬──── (auto) probe Anthropic, fall back to local
│             │           ├──── --local force local
│             │           └──── --remote force Anthropic
│             │
│             │     claude-smart --local
│             │ ──────────────────────► localhost:8080 (llama-server)
└─────────────┘                          │
                                          ├─► distrobox container
                                          │     └─► llama.cpp + ROCm 7.2.3
                                          │           └─► gfx1151 GPU
                                          │
                                          └─► serves Anthropic Messages API
                                               natively (no proxy)
```

The `claude-smart` wrapper sets three env vars (`ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`) for one invocation and `exec`s
into `claude`. The Claude Code CLI doesn't know it's talking to a local model
— from its perspective, it's just hitting an Anthropic API endpoint.

## Lessons learned the hard way

This setup looks simple now, but the path here was littered with dead ends.
The full debug story is preserved in [`docs/PX13-BAZZITE.md`](docs/PX13-BAZZITE.md)
under "What we ruled out (so you don't waste time)". Highlights:

- **The `rocm-7rc-rocwmma` kyuz0 toolbox image ships HSA runtime 1.18.0**,
  which segfaults during tensor upload on gfx1151. Use `rocm-7.2.3` instead.
- **`-c N --parallel P` divides context across slots**. Claude Code + claude-mem
  injects ~30-40K tokens of system prompt + tools on first request. With
  `--parallel 2`, you need `-c 131072` minimum.
- **Qwen3.6-35B-A3B is hybrid Transformer+Mamba**. ROCm doesn't support Mamba
  SSM kernels (as of mid-2026). Stick with Qwen3-Coder for now.
- **Unsloth Dynamic 2.0 quants** of Qwen3-Coder-30B have a Llama-3-style
  tokenizer artifact that crashes loading. Use the LM Studio Community quant.
- **The `<tool_call>` "control token" warning during model load is harmless cosmetic
  noise**. Not the cause of any crash.
- **Always check `dmesg` first when GPU stuff silently dies**. The HSA runtime
  segfault is invisible in llama.cpp's stdout but obvious in kernel logs.
- **On Bazzite/Fedora, drop `--group-add sudo`** from kyuz0's example. That's
  Ubuntu-only; Fedora uses `wheel`, and distrobox doesn't need either.

## Credits

- [kyuz0/amd-strix-halo-toolboxes](https://github.com/kyuz0/amd-strix-halo-toolboxes)
  — the toolbox images that make this work
- [pablo-ross/strix-halo-gmktec-evo-x2](https://github.com/pablo-ross/strix-halo-gmktec-evo-x2)
  — the original benchmark + setup that started this project
- [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp) — the inference
  engine, plus PR #17570 for native Anthropic Messages API support
- [LM Studio Community](https://huggingface.co/lmstudio-community) — stable
  Qwen3-Coder GGUF quants

## License

MIT. See [`LICENSE`](LICENSE).