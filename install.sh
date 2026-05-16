#!/usr/bin/env bash
# install.sh — wire up the local Claude Code backup
#
# Usage:
#   ./install.sh                 # PX13 / Strix Halo (default)
#   ./install.sh --duo           # Zenbook Duo / CPU-only
#   ./install.sh --bridge        # Tailscale bridge (point at remote PX13)
#
# What this does:
#   1. Drops bin/claude-smart into ~/.local/bin/
#   2. Installs the systemd user unit appropriate for the chosen mode
#   3. Verifies prerequisites and reports what's missing
#
# What this does NOT do:
#   - Set kernel arguments (sudo + reboot, see docs/)
#   - Create distrobox containers (see docs/)
#   - Download models (see docs/)
#   - Configure Tailscale (see docs/TAILSCALE-BRIDGE.md)

set -euo pipefail

BIN_DIR="${HOME}/.local/bin"
SYSTEMD_DIR="${HOME}/.config/systemd/user"

MODE="px13"

for arg in "$@"; do
  case "$arg" in
    --duo)     MODE="duo" ;;
    --bridge)  MODE="bridge" ;;
    --px13)    MODE="px13" ;;
    --help|-h)
      cat <<EOF
install.sh — claude-local installer

  ./install.sh             PX13 / Strix Halo (default)
  ./install.sh --duo       Zenbook Duo / CPU-only inference
  ./install.sh --bridge    Tailscale bridge — claude-smart only, no systemd unit
                           (Use this on client machines pointing at a remote PX13)
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg"
      echo "Run with --help"
      exit 1
      ;;
  esac
done

C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'
C_BOLD=$'\033[1m'; C_RST=$'\033[0m'

ok()   { echo "${C_GREEN}✓${C_RST} $*"; }
warn() { echo "${C_YELLOW}!${C_RST} $*"; }
err()  { echo "${C_RED}✗${C_RST} $*"; }
info() { echo "  $*"; }

echo "${C_BOLD}claude-local installer (mode: ${MODE})${C_RST}"
echo

# ---- 1. Install claude-smart -----------------------------------------------

if [[ ! -f "./bin/claude-smart" ]]; then
  err "bin/claude-smart not found"
  err "Run this from the root of the claude-local repo"
  exit 1
fi

mkdir -p "$BIN_DIR"
cp ./bin/claude-smart "$BIN_DIR/claude-smart"
chmod +x "$BIN_DIR/claude-smart"
ok "installed claude-smart → ${BIN_DIR}/claude-smart"

if [[ ":$PATH:" != *":$BIN_DIR:"* ]]; then
  warn "${BIN_DIR} is not on your PATH"
  info "Add this to ~/.bashrc:"
  info "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# ---- 2. Install systemd unit (unless --bridge) -----------------------------

if [[ "$MODE" != "bridge" ]]; then
  mkdir -p "$SYSTEMD_DIR"

  if [[ "$MODE" == "px13" ]]; then
    UNIT_SRC="./systemd/llama-server-px13.service"
    MODEL_PATH="${HOME}/models/qwen3-coder-30b/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf"
    CONTAINER_NAME="llama-rocm"
    CONTAINER_IMAGE="docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.3"
  else
    UNIT_SRC="./systemd/llama-server-duo.service"
    MODEL_PATH="${HOME}/models/qwen2.5-coder-3b/Qwen2.5-Coder-3B-Instruct-Q4_K_M.gguf"
  fi

  if [[ ! -f "$UNIT_SRC" ]]; then
    err "Unit file not found: $UNIT_SRC"
    exit 1
  fi

  cp "$UNIT_SRC" "$SYSTEMD_DIR/llama-server.service"
  ok "installed systemd unit → ${SYSTEMD_DIR}/llama-server.service (from ${UNIT_SRC})"

  systemctl --user daemon-reload
  ok "systemd daemon reloaded"
fi

# ---- 3. Prerequisite checks -------------------------------------------------

echo
echo "${C_BOLD}Prerequisite checks:${C_RST}"

if [[ "$MODE" == "px13" ]]; then
  # Kernel args
  if grep -q "amdgpu.gttsize=131072" /proc/cmdline 2>/dev/null; then
    ok "kernel arg gttsize=131072 present"
  else
    err "kernel arg gttsize=131072 NOT set — model will fail to load"
    info "Run:"
    info "  sudo rpm-ostree kargs --append=amdgpu.gttsize=131072 \\"
    info "    --append=amd_iommu=off --append=ttm.pages_limit=31457280"
    info "Then: sudo systemctl reboot"
  fi

  if grep -q "amd_iommu=off" /proc/cmdline 2>/dev/null; then
    ok "kernel arg amd_iommu=off present"
  else
    warn "kernel arg amd_iommu=off NOT set"
  fi
fi

if [[ "$MODE" != "bridge" ]]; then
  # Container runtime check
  if [[ "$MODE" == "px13" ]]; then
    # PX13 uses distrobox + ROCm container
    if command -v distrobox >/dev/null 2>&1; then
      if distrobox list 2>/dev/null | grep -q "llama-rocm"; then
        ok "distrobox container 'llama-rocm' exists"
        if distrobox enter llama-rocm -- which llama-server >/dev/null 2>&1; then
          ok "llama-server binary present in container"
        else
          err "llama-server not found in container"
          info "The kyuz0 rocm-7.2.3 image should ship with it pre-built."
          info "Recreate the container with the image above."
        fi
      else
        err "distrobox container 'llama-rocm' not found"
        info "Create it with:"
        info "  distrobox create --name llama-rocm \\"
        info "    --image docker.io/kyuz0/amd-strix-halo-toolboxes:rocm-7.2.3 \\"
        info "    --additional-flags \"--device /dev/dri --device /dev/kfd --group-add video --group-add render --security-opt seccomp=unconfined\""
      fi
    else
      err "distrobox not installed"
    fi
  else
    # Duo uses direct podman + server-vulkan image (NOT plain :server — that's CPU-only)
    if command -v podman >/dev/null 2>&1; then
      ok "podman available"
      if podman image exists ghcr.io/ggml-org/llama.cpp:server-vulkan 2>/dev/null; then
        ok "llama.cpp server-vulkan image pulled"
      else
        warn "llama.cpp server-vulkan image not yet pulled"
        info "Run: podman pull ghcr.io/ggml-org/llama.cpp:server-vulkan"
        info "(Use :server-vulkan, NOT :server — :server runs CPU-only)"
      fi
    else
      err "podman not installed"
    fi
  fi

  # Model file
  if [[ -f "$MODEL_PATH" ]]; then
    size=$(du -h "$MODEL_PATH" | cut -f1)
    ok "model file present (${size})"
  else
    err "model file not found at ${MODEL_PATH}"
    if [[ "$MODE" == "px13" ]]; then
      info "Run: hf download lmstudio-community/Qwen3-Coder-30B-A3B-Instruct-GGUF \\"
      info "       --include \"*Q4_K_M*\" --local-dir ~/models/qwen3-coder-30b"
    else
      info "Run: hf download bartowski/Qwen2.5-Coder-3B-Instruct-GGUF \\"
      info "       --include \"*Q4_K_M*\" --local-dir ~/models/qwen2.5-coder-3b"
    fi
  fi

  # Linger
  if loginctl show-user "$USER" 2>/dev/null | grep -q "Linger=yes"; then
    ok "user lingering enabled"
  else
    warn "user lingering not enabled (service won't survive logout)"
    info "Run: sudo loginctl enable-linger $USER"
  fi
fi

# Bridge mode notes
if [[ "$MODE" == "bridge" ]]; then
  warn "Bridge mode: edit ~/.local/bin/claude-smart and set LOCAL_URL"
  info "  to your remote PX13's Tailscale IP or MagicDNS name."
  info "  See docs/TAILSCALE-BRIDGE.md for the full setup."

  if command -v tailscale >/dev/null 2>&1; then
    if tailscale status >/dev/null 2>&1; then
      ok "tailscale is up"
      info "Your tailnet peers:"
      tailscale status | grep -v "^$" | head -5 | sed 's/^/    /'
    else
      warn "tailscale installed but not logged in (run: sudo tailscale up)"
    fi
  else
    err "tailscale not installed"
    info "Install with: sudo rpm-ostree install tailscale && sudo systemctl reboot"
  fi
fi

# ---- 4. Next steps ----------------------------------------------------------

echo
echo "${C_BOLD}Next steps:${C_RST}"

if [[ "$MODE" == "bridge" ]]; then
  echo "  1. Edit ~/.local/bin/claude-smart and set LOCAL_URL to your PX13"
  echo "  2. Smoke test:"
  echo "       claude-smart --status"
  echo "  3. Use it:"
  echo "       claude-smart --local"
else
  echo "  1. Address any ✗ marks above"
  echo "  2. Start the server:"
  echo "       systemctl --user enable --now llama-server.service"
  echo "  3. Watch it load:"
  echo "       journalctl --user -u llama-server -f"
  echo "  4. Smoke test:"
  echo "       claude-smart --status"
  echo "  5. Use it:"
  echo "       claude-smart --local    # force local"
  echo "       claude-smart            # auto: real API, fall back to local"
fi

echo
echo "${C_BOLD}Done.${C_RST}"
