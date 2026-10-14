#!/usr/bin/env bash
# Install Pipo on Linux or macOS from a checkout of its repository, then verify the install (docs/guide/install.md).
#
#   curl -fsSL https://raw.githubusercontent.com/ramigb/pipo/main/install.sh | bash
#   ./install.sh                 # from a checkout: installs that checkout
#   ./install.sh --check         # verify an existing install and look for updates, change nothing
#
# It checks the prerequisites (Bun ≥ 1.3, Rust/cargo, a C compiler, git), offers to install Bun and Rust when they're
# missing, and finds an existing install (the checkout in --dir, or the one the `pipo` command runs). If there is one, it
# fetches and, when the upstream branch has new commits, lists them and offers to update; otherwise it clones. Then it
# runs `bun install` (which builds the Rust runner), links the `pipo` command, and verifies the result end to end: the
# runner binary, `pipo check examples`, a `pipo test` run through the runner, and an engine started and stopped in a
# throwaway Pipo home. Run with --help for the options.
set -euo pipefail

REPO_URL="${PIPO_REPO:-https://github.com/ramigb/pipo.git}"
DEFAULT_DIR="${PIPO_DIR:-$HOME/.local/share/pipo}"
MIN_BUN="1.3.0"
MIN_RUST="1.85.0" # crates/pipo-runner uses edition 2024
BUN_BIN="${BUN_INSTALL:-$HOME/.bun}/bin" # where `bun link` puts the pipo command

usage() {
  cat <<'EOF'
Install Pipo and verify the install.

Usage: install.sh [options]

Options:
  --dir <path>     Where the checkout lives (default: this checkout when run from one,
                   else $PIPO_DIR, else ~/.local/share/pipo, else the checkout `pipo` runs)
  --branch <ref>   Branch to clone or update (default: the repository's default branch)
  --check          Verify an existing install and say whether an update is available; change nothing
  --yes, -y        Install missing prerequisites (Bun, Rust) and updates without asking
  --no-link        Don't link the `pipo` command into Bun's global bin folder
  --no-update      Use an existing checkout as it is (don't look for updates)
  --skip-engine    Skip the engine start/stop check
  -h, --help       Show this help

Environment: PIPO_REPO (repository URL), PIPO_DIR (checkout), PIPO_HOME (Pipo home, default ~/.pipo).
EOF
}

# ── output ─────────────────────────────────────────────────────────────────────────────────────────────────────────
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  B=$'\033[1m' DIM=$'\033[2m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' BLUE=$'\033[34m' R=$'\033[0m'
else
  B="" DIM="" RED="" GREEN="" YELLOW="" BLUE="" R=""
fi
FAILED=0
WARNED=0
step() { printf '\n%s==>%s %s%s%s\n' "$BLUE" "$R" "$B" "$*" "$R"; }
info() { printf '    %s\n' "$*"; }
ok() { printf '  %s✓%s %s\n' "$GREEN" "$R" "$*"; }
warn() {
  WARNED=$((WARNED + 1))
  printf '  %s!%s %s\n' "$YELLOW" "$R" "$*"
}
bad() {
  FAILED=$((FAILED + 1))
  printf '  %s✗%s %s\n' "$RED" "$R" "$*"
}
note() { printf '  %s↑%s %s\n' "$YELLOW" "$R" "$*"; }
hint() { printf '    %s→ %s%s\n' "$DIM" "$*" "$R"; }
die() {
  printf '\n%serror:%s %s\n' "$RED" "$R" "$1" >&2
  [ -n "${2:-}" ] && printf '%shint:%s %s\n' "$DIM" "$R" "$2" >&2
  exit 1
}

# ── helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────
# version_ge A B: A >= B, comparing dot-separated numbers (bash 3.2 has no sort -V on every macOS).
version_ge() {
  local IFS=.
  # shellcheck disable=SC2206
  local a=($1) b=($2) i
  for i in 0 1 2; do
    local x=${a[i]:-0} y=${b[i]:-0}
    x=${x%%[!0-9]*} y=${y%%[!0-9]*}
    if ((${x:-0} > ${y:-0})); then return 0; fi
    if ((${x:-0} < ${y:-0})); then return 1; fi
  done
  return 0
}

# has_tty: a terminal to ask on. /dev/tty exists even without one (cron, CI, setsid), so try to open it.
has_tty() { { : </dev/tty >/dev/tty; } 2>/dev/null; }

# ask "question": yes with --yes; otherwise ask on the terminal (works under `curl … | bash`); no terminal means no.
ask() {
  [ "$YES" = 1 ] && return 0
  has_tty || return 1
  local answer
  printf '  %s?%s %s [Y/n] ' "$BLUE" "$R" "$1" >/dev/tty
  read -r answer </dev/tty || return 1
  case "$answer" in "" | y | Y | yes | YES) return 0 ;; *) return 1 ;; esac
}

# resolve PATH: follow symlinks to the real file (macOS before 13 has no realpath).
resolve() {
  local p=$1 t
  while [ -L "$p" ]; do
    t="$(readlink "$p")"
    case "$t" in /*) p=$t ;; *) p="$(dirname "$p")/$t" ;; esac
  done
  echo "$(cd -P "$(dirname "$p")" && pwd)/$(basename "$p")"
}

is_checkout() { [ -f "$1/crates/pipo-runner/Cargo.toml" ] && [ -f "$1/packages/cli/src/main.ts" ]; }

# linked_checkout: the checkout the `pipo` command runs (on PATH, or linked into Bun's bin folder), if there is one.
linked_checkout() {
  local cmd target
  cmd="$(command -v pipo 2>/dev/null || true)"
  [ -z "$cmd" ] && [ -e "$BUN_BIN/pipo" ] && cmd="$BUN_BIN/pipo"
  [ -n "$cmd" ] || return 1
  target="$(resolve "$cmd")"
  target="${target%/packages/cli/src/main.ts}"
  is_checkout "$target" && echo "$target"
}

# The checkout's commit, for messages: "ae329db, 2026-10-12".
at() { git -C "$DIR" log -1 --format='%h, %cd' --date=short "${1:-HEAD}"; }

# Git never asks for credentials here: an unreachable or private remote fails instead of hanging the install.
qgit() { GIT_TERMINAL_PROMPT=0 git -C "$DIR" "$@"; }

# Bun and cargo may be installed but not on PATH yet (a fresh install, a shell profile not reloaded).
find_bun() {
  BUN="$(command -v bun 2>/dev/null || true)"
  if [ -z "$BUN" ] && [ -x "${BUN_INSTALL:-$HOME/.bun}/bin/bun" ]; then
    BUN="${BUN_INSTALL:-$HOME/.bun}/bin/bun"
    export PATH="$BUN_BIN:$PATH"
  fi
}
find_cargo() {
  CARGO="$(command -v cargo 2>/dev/null || true)"
  if [ -z "$CARGO" ] && [ -x "${CARGO_HOME:-$HOME/.cargo}/bin/cargo" ]; then
    CARGO="${CARGO_HOME:-$HOME/.cargo}/bin/cargo"
    export PATH="$(dirname "$CARGO"):$PATH"
  fi
}

c_compiler_hint() {
  if [ "$OS" = Darwin ]; then
    echo "install the Xcode command line tools: xcode-select --install"
  elif command -v apt-get >/dev/null; then
    echo "sudo apt-get install -y build-essential"
  elif command -v dnf >/dev/null; then
    echo "sudo dnf install -y gcc gcc-c++ make"
  elif command -v pacman >/dev/null; then
    echo "sudo pacman -S --needed base-devel"
  elif command -v apk >/dev/null; then
    echo "sudo apk add build-base"
  elif command -v zypper >/dev/null; then
    echo "sudo zypper install -y gcc gcc-c++ make"
  else
    echo "install gcc or clang with your package manager"
  fi
}

# run_logged "label" cmd…: run a check quietly; on failure show the end of its output.
run_logged() {
  local label=$1 log
  shift
  log="$WORK/$(echo "$label" | tr -c 'a-zA-Z0-9' '-').log"
  if "$@" >"$log" 2>&1; then
    return 0
  fi
  bad "$label"
  sed 's/^/      /' "$log" | tail -n 20
  return 1
}

# ── steps ──────────────────────────────────────────────────────────────────────────────────────────────────────────
check_platform() {
  step "Platform"
  OS="$(uname -s)"
  case "$OS" in
    Linux | Darwin) ok "$OS $(uname -m)" ;;
    *) die "Pipo runs on Linux and macOS, not $OS" "on Windows, use WSL 2 and run this script inside it" ;;
  esac
  local home="${PIPO_HOME:-$HOME/.pipo}"
  case "$home" in
    /mnt/[a-z]/*)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        warn "Pipo home ($home) is on a Windows drive: SQLite's WAL and Unix sockets don't work reliably there"
        hint "point PIPO_HOME at a folder on the Linux file system, such as ~/.pipo"
      fi
      ;;
  esac
}

check_prereqs() {
  step "Prerequisites"
  local can_change=$1

  if command -v git >/dev/null; then ok "git $(git --version | awk '{print $3}')"; else
    bad "git is missing"
    if [ "$OS" = Darwin ]; then hint "xcode-select --install (the command line tools include git)"; else
      hint "install git with your package manager, e.g. sudo apt-get install -y git"
    fi
  fi

  if command -v cc >/dev/null || command -v gcc >/dev/null || command -v clang >/dev/null; then
    ok "C compiler ($(command -v cc || command -v gcc || command -v clang))"
  else
    bad "no C compiler: the runner's build compiles SQLite, QuickJS and its TLS library from C"
    hint "$(c_compiler_hint)"
  fi

  # Bun
  find_bun
  local bun_version=""
  [ -n "$BUN" ] && bun_version="$("$BUN" --version 2>/dev/null || true)"
  if [ -n "$bun_version" ] && version_ge "$bun_version" "$MIN_BUN"; then
    ok "bun $bun_version"
  elif [ "$can_change" = 1 ] && [ -n "$bun_version" ] && ask "bun $bun_version is older than $MIN_BUN. Upgrade it (bun upgrade)?"; then
    "$BUN" upgrade
    ok "bun $("$BUN" --version)"
  elif [ "$can_change" = 1 ] && [ -z "$bun_version" ] && ask "Bun isn't installed. Install it from bun.sh?"; then
    command -v curl >/dev/null || die "curl is needed to install Bun" "install curl, or Bun yourself: https://bun.sh"
    curl -fsSL https://bun.sh/install | bash
    find_bun
    [ -n "$BUN" ] || die "Bun's installer finished, but bun isn't in ~/.bun/bin" "install Bun by hand: https://bun.sh"
    ok "bun $("$BUN" --version)"
  else
    if [ -n "$bun_version" ]; then bad "bun $bun_version is older than $MIN_BUN"; else bad "bun is missing"; fi
    hint "install or upgrade Bun: curl -fsSL https://bun.sh/install | bash   (or rerun this script with --yes)"
  fi

  # Rust
  find_cargo
  local rust_version=""
  [ -n "$CARGO" ] && rust_version="$(rustc --version 2>/dev/null | awk '{print $2}' || true)"
  if [ -n "$rust_version" ] && version_ge "$rust_version" "$MIN_RUST"; then
    ok "rust $rust_version (cargo)"
  elif [ "$can_change" = 1 ] && [ -n "$rust_version" ] && command -v rustup >/dev/null &&
    ask "Rust $rust_version is older than $MIN_RUST. Update it (rustup update stable)?"; then
    rustup update stable
    ok "rust $(rustc --version | awk '{print $2}') (cargo)"
  elif [ "$can_change" = 1 ] && [ -z "$rust_version" ] && ask "Rust isn't installed. Install it with rustup (rustup.rs)?"; then
    command -v curl >/dev/null || die "curl is needed to install Rust" "install curl, or Rust yourself: https://rustup.rs"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
    find_cargo
    [ -n "$CARGO" ] || die "rustup finished, but cargo isn't in ~/.cargo/bin" "install Rust by hand: https://rustup.rs"
    ok "rust $(rustc --version | awk '{print $2}') (cargo)"
  else
    if [ -n "$rust_version" ]; then bad "rust $rust_version is older than $MIN_RUST"; else bad "cargo (Rust) is missing"; fi
    hint "install Rust: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh   (or rerun this script with --yes)"
  fi

  [ "$FAILED" = 0 ] || die "missing prerequisites (above)" "install them, then run this script again"
}

get_checkout() {
  step "Checkout"
  if [ -d "$DIR/.git" ] && is_checkout "$DIR"; then
    if [ "$FOUND_BY_LINK" = 1 ]; then ok "Pipo is installed in $DIR (the checkout your pipo command runs), at $(at)"; else
      ok "Pipo is installed in $DIR, at $(at)"
    fi
    if [ "$UPDATE" = 1 ]; then update_checkout; else info "not looking for updates (--no-update)"; fi
  elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
    die "$DIR exists and isn't a Pipo checkout" "choose another folder with --dir, or empty that one"
  else
    info "cloning $REPO_URL into $DIR"
    mkdir -p "$(dirname "$DIR")"
    git clone -q ${BRANCH:+--branch "$BRANCH"} "$REPO_URL" "$DIR"
    ok "cloned $(at)"
  fi
}

# update_checkout: fetch, list the upstream branch's new commits and offer to fast-forward to them. Never touches local
# changes or local commits. When the update changes install.sh, the new install.sh finishes the install.
update_checkout() {
  local branch upstream behind ahead before dirty=""
  [ -n "$(git -C "$DIR" status --porcelain)" ] && dirty=1
  branch="$(git -C "$DIR" symbolic-ref -q --short HEAD || true)"
  if [ -z "$branch" ] && [ -z "$BRANCH" ]; then
    warn "it's on a detached HEAD, so it can't be updated"
    hint "git -C $DIR checkout main, then run this script again"
    return
  fi
  if ! qgit fetch -q 2>/dev/null; then
    warn "couldn't reach $(git -C "$DIR" remote get-url origin 2>/dev/null || echo origin) to look for updates"
    return
  fi
  if [ -n "$BRANCH" ] && [ "$branch" != "$BRANCH" ]; then
    if [ -n "$dirty" ]; then
      warn "it has local changes, so it wasn't switched to $BRANCH"
      return
    fi
    git -C "$DIR" checkout -q "$BRANCH" || {
      warn "couldn't switch to $BRANCH"
      return
    }
    branch=$BRANCH
    ok "switched to $BRANCH, at $(at)"
  fi
  upstream="$(git -C "$DIR" rev-parse -q --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [ -z "$upstream" ]; then
    warn "branch $branch has no upstream branch, so it can't be checked for updates"
    hint "git -C $DIR branch --set-upstream-to origin/main"
    return
  fi
  behind="$(git -C "$DIR" rev-list --count 'HEAD..@{u}')"
  ahead="$(git -C "$DIR" rev-list --count '@{u}..HEAD')"
  if [ "$behind" = 0 ]; then
    ok "up to date with $upstream"
    return
  fi

  note "a newer version is available: $behind new commit(s) on $upstream, up to $(at '@{u}')"
  git -C "$DIR" log --format='%h %s' 'HEAD..@{u}' | head -n 8 | sed "s/^/      ${DIM}/; s/\$/${R}/"
  [ "$behind" -gt 8 ] && info "${DIM}  … and $((behind - 8)) more${R}"
  if [ -n "$dirty" ]; then
    warn "it has local changes, so it wasn't updated"
    hint "commit or stash them, then run this script again (or: git -C $DIR pull --ff-only)"
  elif [ "$ahead" != 0 ]; then
    warn "$branch has $ahead local commit(s) that aren't on $upstream, so it can't fast-forward"
    hint "git -C $DIR pull --rebase, then run this script again"
  elif ! ask "Update Pipo to $(git -C "$DIR" rev-parse --short '@{u}')?"; then
    info "not updated: it stays at $(at)"
    has_tty || hint "no terminal to ask on: rerun with --yes to update"
  else
    before="$(git -C "$DIR" rev-parse HEAD)"
    if ! git -C "$DIR" merge -q --ff-only '@{u}'; then
      warn "the fast-forward failed, so it stays at $(at)"
      return
    fi
    ok "updated to $(at)"
    if ! git -C "$DIR" diff --quiet "$before" HEAD -- install.sh; then
      info "install.sh changed in this update: continuing with the new one"
      cleanup
      trap - EXIT
      exec bash "$DIR/install.sh" ${ARGS[@]+"${ARGS[@]}"} --dir "$DIR" --no-update
    fi
  fi
}

# report_updates: for --check, whether the upstream branch has commits this checkout lacks. Asks the remote with
# ls-remote, so it fetches nothing and changes nothing.
report_updates() {
  step "Updates"
  if ! [ -d "$DIR/.git" ] || ! is_checkout "$DIR"; then
    info "no checkout in $DIR to check"
    return
  fi
  local branch remote merge sha
  branch="$(git -C "$DIR" symbolic-ref -q --short HEAD || true)"
  remote="$(git -C "$DIR" config "branch.$branch.remote" 2>/dev/null || true)"
  merge="$(git -C "$DIR" config "branch.$branch.merge" 2>/dev/null || true)"
  if [ -z "$branch" ]; then
    info "$DIR is on a detached HEAD at $(at), so it wasn't checked"
  elif [ -z "$remote" ] || [ -z "$merge" ]; then
    info "branch $branch has no upstream branch, so it wasn't checked"
  elif ! sha="$(qgit ls-remote -q "$remote" "$merge" 2>/dev/null | awk 'NR == 1 {print $1}')" || [ -z "$sha" ]; then
    warn "couldn't reach $remote to look for updates"
  elif git -C "$DIR" merge-base --is-ancestor "$sha" HEAD 2>/dev/null; then
    ok "up to date with $remote/${merge#refs/heads/} ($(at))"
  else
    note "a newer version is available on $remote/${merge#refs/heads/} (this checkout is at $(at))"
    hint "run $DIR/install.sh to update"
  fi
}

install_deps() {
  step "Dependencies and the runner"
  info "bun install (also builds the Rust runner; the first build takes a few minutes)"
  (cd "$DIR" && "$BUN" install)
  if [ ! -x "$DIR/target/release/pipo-runner" ]; then
    info "building the runner: cargo build --release -p pipo-runner"
    (cd "$DIR" && "$BUN" run build:runner) || die "the runner didn't build" \
      "read cargo's errors above; an old toolchain is the usual cause (rustup update stable)"
  fi
  ok "runner built at target/release/pipo-runner"
}

link_cli() {
  step "The pipo command"
  (cd "$DIR/packages/cli" && "$BUN" link >/dev/null)
  ok "linked into $BUN_BIN"
}

verify() {
  step "Verify"
  FAILED=0
  local pipo=("$BUN" "$DIR/packages/cli/src/main.ts")

  find_bun
  if [ -n "$BUN" ] && version_ge "$("$BUN" --version)" "$MIN_BUN"; then ok "bun $("$BUN" --version)"; else
    bad "bun $MIN_BUN or newer isn't installed"
    return
  fi
  is_checkout "$DIR" || {
    bad "$DIR isn't a Pipo checkout"
    hint "run install.sh without --check to install, or pass --dir"
    return
  }
  [ -d "$DIR/node_modules" ] || {
    bad "dependencies aren't installed in $DIR"
    hint "cd $DIR && bun install"
    return
  }

  # The runner binary: present, current (pipo rebuilds a stale one on demand), and it runs.
  local bin="${PIPO_RUNNER_BIN:-$DIR/target/release/pipo-runner}"
  if [ ! -x "$bin" ]; then
    bad "no runner binary at $bin"
    hint "cd $DIR && bun run build:runner"
  else
    local out
    out="$("$bin" 2>&1 || true)"
    if [[ "$out" == *"usage: pipo-runner"* ]]; then ok "runner binary runs ($bin)"; else
      bad "the runner binary at $bin doesn't run: ${out:0:200}"
      hint "rebuild it: cd $DIR && bun run build:runner"
    fi
    if [ -z "${PIPO_RUNNER_BIN:-}" ] &&
      [ -n "$(find "$DIR/crates/pipo-runner/src" "$DIR/Cargo.lock" -newer "$bin" -print -quit 2>/dev/null)" ]; then
      warn "the runner binary is older than its sources; pipo rebuilds it the next time it needs it"
    fi
  fi

  find_cargo
  if [ -n "$CARGO" ]; then ok "cargo $("$CARGO" --version | awk '{print $2}') (to rebuild the runner after updates)"; else
    warn "cargo isn't installed: the runner can't be rebuilt after a git pull"
    hint "install Rust: https://rustup.rs"
  fi

  # The CLI, the checker and every example.
  run_logged "pipo --help" "${pipo[@]}" --help && ok "pipo CLI starts"
  run_logged "pipo check examples" "${pipo[@]}" check "$DIR/examples" &&
    ok "pipo check examples: all pass"

  # A pipeline through the real runner: compile, the Rust runner, an fn module in QuickJS, the journal.
  local home="$WORK/home"
  if run_logged "pipo test (people-intake through the runner)" \
    "${pipo[@]}" test "$DIR/examples/people-intake/people-intake.pipo" --home "$home"; then
    ok "pipo test runs a pipeline through the runner (examples/people-intake)"
  fi

  # The engine: start it in a throwaway home, fetch the dashboard, stop it.
  if [ "$SKIP_ENGINE" = 1 ]; then
    info "skipped the engine check (--skip-engine)"
  elif ! command -v curl >/dev/null; then
    warn "curl isn't installed, so the engine check was skipped"
  else
    local ehome="$WORK/engine-home" started port code
    if started="$("${pipo[@]}" engine start --home "$ehome" --listen 0 --json 2>"$WORK/engine.err")"; then
      ENGINE_HOME="$ehome"
      port="$(printf '%s' "$started" | sed -n 's/.*"listen":\([0-9]*\).*/\1/p')"
      code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/ui/" || true)"
      if [ "$code" = 200 ]; then ok "engine starts and serves the dashboard (port $port, then stopped)"; else
        bad "the engine started, but /ui answered HTTP $code"
        hint "see $ehome/logs/engine.log"
      fi
      "${pipo[@]}" engine stop --home "$ehome" >/dev/null 2>&1 && ENGINE_HOME=""
    else
      bad "the engine didn't start"
      sed 's/^/      /' "$WORK/engine.err" | tail -n 20
    fi
  fi

  # The pipo command on PATH.
  local onpath
  onpath="$(command -v pipo 2>/dev/null || true)"
  if [ -z "$onpath" ]; then
    if [ "$NO_LINK" = 1 ]; then
      info "pipo isn't on PATH (--no-link): run it as bun pipo … from $DIR"
    elif [ -e "$BUN_BIN/pipo" ]; then
      warn "pipo is linked in $BUN_BIN, which isn't on your PATH"
      hint "add to your shell profile: export PATH=\"$BUN_BIN:\$PATH\""
    else
      warn "pipo isn't on your PATH"
      hint "cd $DIR/packages/cli && bun link"
    fi
  else
    local target
    target="$(resolve "$onpath")"
    if [[ "$target" != "$(cd -P "$DIR" && pwd)/"* ]]; then
      warn "pipo on your PATH ($onpath) runs $target, not this checkout"
      hint "cd $DIR/packages/cli && bun link"
    elif pipo --help >/dev/null 2>&1; then
      ok "pipo is on your PATH ($onpath)"
    else
      bad "pipo is on your PATH ($onpath), but doesn't run"
    fi
  fi

  # Optional tools: only some pipelines need them.
  step "Optional tools"
  local tool why
  for tool in "op:1Password CLI, for op:// secrets" "claude:Claude Code, for claude_code agent nodes and the plugin" \
    "codex:Codex CLI, for codex agent nodes" "pi:pi CLI, for pi agent nodes" \
    "opencode:opencode CLI, for opencode agent nodes" "ffmpeg:for exec steps such as examples/audio-to-video"; do
    why="${tool#*:}"
    tool="${tool%%:*}"
    if command -v "$tool" >/dev/null; then ok "$tool ${DIM}($why)${R}"; else info "${DIM}–  $tool not found ($why)${R}"; fi
  done
}

cleanup() {
  if [ -n "${ENGINE_HOME:-}" ] && [ -n "${BUN:-}" ]; then
    "$BUN" "$DIR/packages/cli/src/main.ts" engine stop --home "$ENGINE_HOME" >/dev/null 2>&1 || true
  fi
  [ -n "${WORK:-}" ] && rm -rf "$WORK"
}

main() {
  ARGS=("$@")
  DIR="" BRANCH="" CHECK=0 YES=0 NO_LINK=0 UPDATE=1 SKIP_ENGINE=0 ENGINE_HOME="" BUN="" CARGO="" FOUND_BY_LINK=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) DIR="${2:?--dir needs a path}" && shift ;;
      --dir=*) DIR="${1#*=}" ;;
      --branch) BRANCH="${2:?--branch needs a ref}" && shift ;;
      --branch=*) BRANCH="${1#*=}" ;;
      --check) CHECK=1 ;;
      --yes | -y) YES=1 ;;
      --no-link) NO_LINK=1 ;;
      --no-update) UPDATE=0 ;;
      --skip-engine) SKIP_ENGINE=1 ;;
      -h | --help) usage && exit 0 ;;
      *) die "unknown option $1" "run install.sh --help for the options" ;;
    esac
    shift
  done

  # Run from a checkout (./install.sh), install that checkout; piped from curl, BASH_SOURCE isn't a file. Otherwise the
  # default folder, unless Pipo is already installed elsewhere and the `pipo` command runs that checkout.
  local here="" linked=""
  [ -f "${BASH_SOURCE[0]:-}" ] && here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -z "$DIR" ]; then
    if [ -n "$here" ] && is_checkout "$here"; then
      DIR="$here"
    elif [ -z "${PIPO_DIR:-}" ] && ! is_checkout "$DEFAULT_DIR" && linked="$(linked_checkout)"; then
      DIR="$linked" FOUND_BY_LINK=1
    else
      DIR="$DEFAULT_DIR"
    fi
  fi
  case "$DIR" in /*) ;; *) DIR="$(pwd)/$DIR" ;; esac

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/pipo-install.XXXXXX")"
  trap cleanup EXIT
  trap 'exit 130' INT TERM

  printf '%sPipo%s %s\n' "$B" "$R" "$([ "$CHECK" = 1 ] && echo "install check" || echo "installer")"
  check_platform
  if [ "$CHECK" = 1 ]; then
    find_bun
    find_cargo
    report_updates
  else
    check_prereqs 1
    get_checkout
    install_deps
    [ "$NO_LINK" = 1 ] || link_cli
  fi
  verify

  printf '\n'
  if [ "$FAILED" -gt 0 ]; then
    printf '%s%s✗ %d check(s) failed.%s Fix the items above, then run: %s --check\n' "$B" "$RED" "$FAILED" "$R" \
      "$DIR/install.sh"
    exit 1
  fi
  printf '%s%s✓ Pipo is installed%s in %s' "$B" "$GREEN" "$R" "$DIR"
  [ "$WARNED" -gt 0 ] && printf ' %s(%d warning(s) above)%s' "$YELLOW" "$WARNED" "$R"
  printf '\n\nNext:\n'
  if command -v pipo >/dev/null; then
    printf '  pipo ui                  open the dashboard and builder\n'
    printf '  pipo new my-pipeline     start a pipeline from a template\n'
  else
    printf '  cd %s && bun pipo ui\n' "$DIR"
  fi
  printf '  Docs: https://ramigb.github.io/pipo/docs/\n'
}

main "$@"
