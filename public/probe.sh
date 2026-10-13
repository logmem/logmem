#!/bin/sh
# LogMem agent probe. Read-only, POSIX sh.
#
#   curl -fsSL https://logmem.si/probe.sh | sh                       # just print
#   curl -fsSL https://logmem.si/probe.sh | LOGMEM_PAIR=ABC123 sh    # print + pair
#
# What it does:
#   1. Looks on your PATH for: claude codex cursor gemini opencode aider goose
#      cline windsurf.
#   2. For each one it finds, runs `<name> --version` (3 second limit) and
#      keeps the first line, cut to 40 printable characters.
#   3. Prints what it found.
#   4. Only when LOGMEM_PAIR is set to the 6-character code from the setup
#      page, POSTs {code, agents:[{name, version}]} to
#      $LOGMEM_URL/api/onboarding/probe (default https://logmem.si) with curl.
#
# What it never does: read config files, read environment variables other
# than PATH, LOGMEM_PAIR and LOGMEM_URL, write files, or send anything when
# LOGMEM_PAIR is unset. The server keeps the result for 10 minutes.
#
# Everything runs inside main(), called on the last line, so a partly
# downloaded script does nothing.

main() {
  agents="claude codex cursor gemini opencode aider goose cline windsurf"
  base="${LOGMEM_URL:-https://logmem.si}"
  pair="${LOGMEM_PAIR:-}"

  timeout_bin=""
  if command -v timeout >/dev/null 2>&1; then timeout_bin="timeout"
  elif command -v gtimeout >/dev/null 2>&1; then timeout_bin="gtimeout"
  fi

  json=""
  found=0
  echo "LogMem probe: looking for agent CLIs on your PATH (read-only)."
  for name in $agents; do
    if command -v "$name" >/dev/null 2>&1; then
      version=$(first_version_line "$name")
      found=$((found + 1))
      if [ -n "$version" ]; then
        printf '  found  %-9s %s\n' "$name" "$version"
      else
        printf '  found  %-9s (no version output)\n' "$name"
      fi
      entry=$(printf '{"name":"%s","version":"%s"}' "$name" "$version")
      if [ -z "$json" ]; then json="$entry"; else json="$json,$entry"; fi
    else
      printf '  -      %s\n' "$name"
    fi
  done
  echo "Found $found of 9."

  if [ -z "$pair" ]; then
    echo "Nothing was sent. To send this list to the setup page, run again with LOGMEM_PAIR=<code>."
    return 0
  fi

  if ! printf '%s' "$pair" | grep -Eq '^[A-Z0-9]{6}$'; then
    echo "LOGMEM_PAIR must be the 6-character code shown on the setup page (A-Z, 0-9). Nothing was sent." >&2
    return 1
  fi
  case "$base" in
    https://*|http://localhost:*|http://localhost|http://127.0.0.1:*|http://127.0.0.1) ;;
    *) echo "LOGMEM_URL must start with https:// (http:// only for localhost). Nothing was sent." >&2; return 1 ;;
  esac
  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is not installed, so nothing was sent. Pick your agents on the setup page instead." >&2
    return 1
  fi

  body=$(printf '{"code":"%s","agents":[%s]}' "$pair" "$json")
  echo "Sending the list above (names and versions only) to $base ..."
  if curl -fsS --max-time 10 -X POST -H 'Content-Type: application/json' --data "$body" "$base/api/onboarding/probe" >/dev/null; then
    echo "Sent. Go back to the setup page; it shows these agents within a few seconds."
  else
    echo "Sending failed. The code may be used already or expired: get a new one on the setup page." >&2
    return 1
  fi
}

# First line of `<cmd> --version`, at most 3 seconds, printable ASCII only
# (no quotes or backslashes, so it is safe inside JSON), at most 40 chars.
first_version_line() {
  if [ -n "$timeout_bin" ]; then
    "$timeout_bin" 3 "$1" --version </dev/null 2>/dev/null | clean_line
  else
    (
      "$1" --version </dev/null 2>/dev/null &
      pid=$!
      ( sleep 3; kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
      watcher=$!
      wait "$pid" 2>/dev/null
      kill "$watcher" 2>/dev/null
    ) | clean_line
  fi
}

clean_line() {
  head -n 1 | LC_ALL=C tr -cd ' -~' | LC_ALL=C tr -d '"\\' | sed 's/^ *//' | cut -c 1-40
}

main "$@"
