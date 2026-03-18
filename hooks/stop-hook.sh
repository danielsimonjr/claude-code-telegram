#!/bin/bash
# Claude Code Stop Hook — sends response back to Telegram bridge
#
# This hook fires when Claude finishes responding. It reads the
# transcript from stdin and writes it to a file that the bridge polls.
#
# Install: Add to ~/.claude/settings.json under hooks.Stop

RESPONSE_DIR="$HOME/.claude-code-telegram/responses"
PENDING_FILE="$HOME/.claude-code-telegram/.pending"

# Only respond if there's a pending Telegram message
if [ ! -f "$PENDING_FILE" ]; then
  exit 0
fi

mkdir -p "$RESPONSE_DIR"

# Read the stop hook input from stdin (JSON with transcript)
INPUT=$(cat)

# Extract the assistant's last message from the stop_hook_active_transcript
# The input is JSON: {"stop_hook_active_transcript": "..."}
RESPONSE=$(echo "$INPUT" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    transcript = data.get('stop_hook_active_transcript', '')
    # Get the last assistant message (after the last 'human:' or user prompt)
    lines = transcript.strip().split('\n')
    # Take the last chunk of output (Claude's response)
    output = []
    collecting = False
    for line in reversed(lines):
        if line.startswith('Human:') or line.startswith('human:'):
            break
        output.insert(0, line)
    result = '\n'.join(output).strip()
    # Truncate if too long for Telegram
    if len(result) > 15000:
        result = result[:15000] + '\n\n... (truncated)'
    print(result)
except Exception as e:
    print(f'(Error parsing response: {e})')
" 2>/dev/null)

# Fallback: if python parsing failed, just take the raw input
if [ -z "$RESPONSE" ]; then
  RESPONSE=$(echo "$INPUT" | head -c 15000)
fi

# Write response for the bridge to pick up
echo "$RESPONSE" > "$RESPONSE_DIR/latest.txt"
