# Aider Setup for Zenbook Duo (Local Qwen3.5-4B)

Aider is a terminal-based AI coding assistant. Unlike Claude Code, it injects
only ~5-10K tokens of context per session — small enough for CPU prefill to
complete in 2-4 minutes rather than timing out at 10-12 minutes.

This doc covers installing Aider and wiring it to the local llama-server on
the Duo. For the server setup, see [`ZENBOOK-DUO.md`](ZENBOOK-DUO.md).

---

## Prerequisites

- llama-server running locally on port 8080 with the `qwen3.5-4b` alias
- `uv` Python toolchain manager (installed below)

---

## 1. Install uv

uv manages its own Python versions per tool. This matters on Bazzite: the
system Python moves fast (currently 3.14), and Aider pins `numpy==1.24.3`
which can't build on 3.14 (`pkgutil.ImpImporter` was removed in 3.12).
System pip is also frequently broken during Python upgrades on Fedora Atomic.

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null
```

---

## 2. Install Aider

```bash
uv tool install --python 3.12 aider-chat
```

This installs Aider in an isolated Python 3.12 venv under
`~/.local/share/uv/tools/aider-chat/` with a symlink at `~/.local/bin/aider`.
Survives system Python upgrades.

Verify:

```bash
aider --version
```

---

## 3. Configure Aider

Create `~/.aider.conf.yml`:

```yaml
openai-api-base: http://127.0.0.1:8080/v1
openai-api-key: local-no-auth-needed
model: openai/qwen3.5-4b
weak-model: openai/qwen3.5-4b
auto-commits: false
dirty-commits: false
edit-format: diff
```

**Config notes:**

- `openai/` prefix — Aider treats llama.cpp's `/v1/chat/completions` as
  OpenAI-compatible. The prefix tells Aider which API format to use.
- Model name `qwen3.5-4b` must exactly match the `--alias` flag passed to
  llama-server in the systemd unit.
- `weak-model: openai/qwen3.5-4b` — prevents Aider from calling the real
  OpenAI API for cheap summarization tasks. Points it at the same local model.
- `edit-format: diff` — works reliably with Qwen3.5-4B. If you switch to a
  smaller model (e.g. 0.8B), use `edit-format: whole` (full-file replacement
  is higher token cost but easier for small models to produce correctly).
- `auto-commits: false` — you review changes before they're committed.

---

## 4. Smoke test

Start the server if not already running:

```bash
systemctl --user start llama-server.service
sleep 30
```

Verify the model is loaded:

```bash
curl -s http://127.0.0.1:8080/v1/models | jq '.data[0].id'
# Expected: "qwen3.5-4b"
```

Full end-to-end test:

```bash
mkdir -p /tmp/aider-test && cd /tmp/aider-test
git init && echo "# Test" > README.md && git add . && git commit -m "init"
aider README.md
```

Type: `What does this file say?`

You should see a response in 2-4 minutes on first cold start. Follow-ups
will be faster (~30-60 sec) once the context is warm.

---

## 5. Typical Aider workflow

```bash
# In your project directory
cd ~/projects/my-project

# Start Aider and load specific files
aider src/main.py src/utils.py

# Inside Aider, add more files as needed
/add tests/test_main.py

# Ask for changes naturally
> Refactor parse_config to handle missing keys gracefully

# Aider generates a diff, applies it, shows the result
# Review it, then commit manually when satisfied
git diff
git add -p
git commit -m "Handle missing keys in parse_config"
```

**Key differences from Claude Code:**

- You explicitly `/add` files instead of the agent discovering them. Keeps
  context small, which is what makes CPU inference viable.
- Aider produces diffs and applies them directly — no tool call loop.
- No automatic git commits — you review and commit yourself (`auto-commits: false`).
- Session context is bounded to what you `/add`, so it stays fast across turns.

---

## 6. Updating Aider

```bash
uv tool upgrade aider-chat
```

---

**See also:** [`ZENBOOK-DUO.md`](ZENBOOK-DUO.md) for the full server setup,
model selection rationale, and the Claude Code timeout wall explanation.
