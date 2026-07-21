#!/usr/bin/env bash
# ============================================================================
#  pi-bootstrap.sh — Deploy pi coding agent with all extensions to a new server
#
#  Usage:
#    curl -fsSL https://raw.githubusercontent.com/seek-hope/pi-extensions/master/scripts/bootstrap.sh | bash
#    OR
#    git clone https://github.com/seek-hope/pi-extensions ~/pi-extensions
#    cd ~/pi-extensions && bash scripts/bootstrap.sh
# ============================================================================
set -euo pipefail

REPO_URL="https://github.com/seek-hope/pi-extensions.git"
EXT_DIR="$HOME/.pi/agent/extensions"
SETTINGS_DIR="$HOME/.pi/agent"
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

say()  { echo -e "${GREEN}==>${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC}  $*"; }
err()  { echo -e "${RED}✗${NC}  $*"; }

# ── Phase 0: prerequisites ──────────────────────────────────────────────────

say "Phase 0: Checking prerequisites..."

command -v node  >/dev/null 2>&1 || { err "Node.js not found. Install Node >= 20 first."; exit 1; }
command -v npm   >/dev/null 2>&1 || { err "npm not found."; exit 1; }
command -v git   >/dev/null 2>&1 || { err "git not found."; exit 1; }

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  warn "Node $(node -v) is below v20. Some extensions may not work."
fi

# ── Phase 1: install pi ─────────────────────────────────────────────────────

say "Phase 1: Installing pi coding agent..."

if command -v pi >/dev/null 2>&1; then
  say "pi already installed: $(pi --version 2>&1 | head -1 || echo 'unknown')"
else
  npm install -g --ignore-scripts @earendil-works/pi-coding-agent
  say "pi installed: $(pi --version 2>&1 | head -1 || echo 'ok')"
fi

# ── Phase 2: clone/deploy extensions ────────────────────────────────────────

say "Phase 2: Deploying extensions..."

if [ -d "$EXT_DIR/.git" ]; then
  say "Extensions already exist, updating..."
  cd "$EXT_DIR" && git pull --ff-only origin master 2>/dev/null || warn "Could not git pull (local changes?)"
else
  mkdir -p "$(dirname "$EXT_DIR")"
  rm -rf "$EXT_DIR"
  git clone "$REPO_URL" "$EXT_DIR"
  say "Extensions cloned to $EXT_DIR"
fi

# ── Phase 3: base settings ──────────────────────────────────────────────────

say "Phase 3: Writing settings..."

mkdir -p "$SETTINGS_DIR"

if [ ! -f "$SETTINGS_DIR/settings.json" ]; then
  cat > "$SETTINGS_DIR/settings.json" << 'SETEOF'
{
  "theme": "dark",
  "defaultProvider": "deepseek",
  "defaultModel": "deepseek-v4-pro",
  "defaultThinkingLevel": "max",
  "defaultProjectTrust": "always",
  "treeFilterMode": "default",
  "doubleEscapeAction": "tree"
}
SETEOF
  say "settings.json created"
else
  say "settings.json already exists, skipping"
fi

# ── Phase 4: install global npm tools ───────────────────────────────────────

say "Phase 4: Installing global npm tools..."

NPM_PACKAGES=(
  "@colbymchenry/codegraph"
  "@sentropic/graphify"
  "playwright"
  "typescript-language-server"
  "pyright"
  "context7"
  "doc-relay"
)

for pkg in "${NPM_PACKAGES[@]}"; do
  if npm list -g "$pkg" --depth=0 >/dev/null 2>&1; then
    say "  $pkg: already installed"
  else
    say "  $pkg: installing..."
    npm install -g "$pkg" 2>&1 | tail -1 || warn "  $pkg: install failed (may need --allow-scripts)"
  fi
done

# Special: doc-relay needs native modules allowed
npm install -g doc-relay --allow-scripts=better-sqlite3 2>/dev/null || warn "doc-relay native rebuild failed (try manually)"

# ── Phase 5: system tools ───────────────────────────────────────────────────

say "Phase 5: Checking system tools..."

check_tool() {
  if command -v "$1" >/dev/null 2>&1; then
    say "  $1: found"
  else
    warn "  $1: NOT FOUND — install manually"
    MISSING_TOOLS+=("$1")
  fi
}

MISSING_TOOLS=()

check_tool "gh"
check_tool "clangd"
check_tool "rust-analyzer"
check_tool "serena"
check_tool "grim"
check_tool "ydotool"
check_tool "wtype"
check_tool "tmux"
check_tool "graphify"

if [ ${#MISSING_TOOLS[@]} -gt 0 ]; then
  echo ""
  warn "Missing tools: ${MISSING_TOOLS[*]}"
  echo "  gh:            https://github.com/cli/cli#installation"
  echo "  clangd:        apt install clangd / pacman -S clang"
  echo "  rust-analyzer: rustup component add rust-analyzer"
  echo "  serena:        uv tool install serena-agent"
  echo "  grim:          pacman -S grim (Wayland screenshots)"
  echo "  ydotool:       pacman -S ydotool (mouse control)"
  echo "  wtype:         pacman -S wtype (keyboard input)"
  echo "  tmux:          pacman -S tmux (background tasks)"
  echo "  graphify:      npm install -g @sentropic/graphify"
fi

# ── Phase 6: playwright browsers ────────────────────────────────────────────

say "Phase 6: Installing Playwright browsers..."

if [ -d "$HOME/.cache/ms-playwright" ]; then
  say "Playwright browsers already installed"
else
  npx playwright install chromium 2>&1 | tail -3 || warn "Playwright browser install failed"
fi

# ── Phase 7: env vars template ──────────────────────────────────────────────

say "Phase 7: API keys template..."

ENV_FILE="$HOME/.pi/agent/env.template"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" << 'ENVEOF'
# Pi agent API keys — copy to ~/.zshrc or ~/.bashrc and fill in values
# (or set them directly via export)

export CONTEXT7_API_KEY=""     # https://context7.com
export ANYSEARCH_API_KEY=""    # https://anysearch.com
export HF_TOKEN=""             # https://huggingface.co/settings/tokens
export YDOTOOL_SOCKET=/tmp/.ydotool_socket  # computer use
export HF_API_KEY=""           # https://huggingface.co/settings/tokens
export HF_TOKEN="$HF_API_KEY"

# DeepSeek API (via Anthropic compat)
export ANTHROPIC_BASE_URL='https://api.deepseek.com/anthropic'
export ANTHROPIC_AUTH_TOKEN='' # your DeepSeek API key
export ANTHROPIC_MODEL='deepseek-v4-pro[1m]'
ENVEOF
  say "env.template created at $ENV_FILE"
else
  say "env.template already exists"
fi

# ── Done ─────────────────────────────────────────────────────────────────────

echo ""
echo "========================================"
echo " Pi deployment complete!"
echo "========================================"
echo ""
echo " Extensions:  $EXT_DIR"
echo " Settings:    $SETTINGS_DIR/settings.json"
echo " API keys:    edit $ENV_FILE and source it, or add to ~/.zshrc"
echo ""
echo " Next steps:"
echo "   1. Configure API keys in ~/.zshrc"
echo "   2. Install missing system tools (if any)"
echo "   3. Start pi:  pi"
echo "   4. In pi:     /reload"
