#!/usr/bin/env bash
# Push content to the Agent Dashboard
# Usage: push.sh --slug <slug> --title <title> [--body <html>|--file <path>|stdin] [options]
set -euo pipefail

# Configuration — set via environment or edit defaults here
BASE_URL="${DASHBOARD_URL:-http://localhost:5858}"
TOKEN="${DASHBOARD_TOKEN:-}"

if [[ -z "$TOKEN" ]]; then
  echo "Error: DASHBOARD_TOKEN is not set. Export it or edit this script." >&2
  exit 1
fi

# Defaults
SLUG=""
TITLE=""
BODY=""
FORMAT="html"
AGENT=""
CATEGORY=""
TAGS=""
TTL=""
PINNED=false
FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --slug)     SLUG="$2"; shift 2 ;;
    --title)    TITLE="$2"; shift 2 ;;
    --body)     BODY="$2"; shift 2 ;;
    --file)     FILE="$2"; shift 2 ;;
    --format)   FORMAT="$2"; shift 2 ;;
    --agent)    AGENT="$2"; shift 2 ;;
    --category) CATEGORY="$2"; shift 2 ;;
    --tags)     TAGS="$2"; shift 2 ;;
    --ttl)      TTL="$2"; shift 2 ;;
    --pinned)   PINNED=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Validate required
if [[ -z "$SLUG" ]]; then echo "Error: --slug is required" >&2; exit 1; fi
if [[ -z "$TITLE" ]]; then echo "Error: --title is required" >&2; exit 1; fi

# Get body from file, argument, or stdin
if [[ -n "$FILE" ]]; then
  if [[ ! -f "$FILE" ]]; then echo "Error: file not found: $FILE" >&2; exit 1; fi
  BODY=$(cat "$FILE")
  # Auto-detect format from extension
  if [[ "$FILE" == *.md ]] && [[ "$FORMAT" == "html" ]]; then
    FORMAT="markdown"
  fi
elif [[ -z "$BODY" ]]; then
  # Try stdin (but only if not a terminal)
  if [[ ! -t 0 ]]; then
    BODY=$(cat)
  else
    echo "Error: provide content via --body, --file, or stdin" >&2; exit 1
  fi
fi

# Build JSON payload
JSON=$(jq -n \
  --arg title "$TITLE" \
  --arg body "$BODY" \
  --arg format "$FORMAT" \
  --arg agent "$AGENT" \
  --arg category "$CATEGORY" \
  --arg tags "$TAGS" \
  --arg ttl "$TTL" \
  --argjson pinned "$PINNED" \
  '{
    title: $title,
    body: $body,
    format: $format,
    replace: true
  }
  + (if $agent != "" then {agent: $agent} else {} end)
  + (if $category != "" then {category: $category} else {} end)
  + (if $tags != "" then {tags: ($tags | split(",") | map(gsub("^\\s+|\\s+$"; "")))} else {} end)
  + (if $ttl != "" then {ttl: ($ttl | tonumber)} else {} end)
  + (if $pinned then {pinned: true} else {} end)
  ')

# Push to dashboard
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}/api/pages/${SLUG}" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$JSON")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
RESP_BODY=$(echo "$RESPONSE" | sed '$d')

if [[ "$HTTP_CODE" == "201" ]] || [[ "$HTTP_CODE" == "200" ]]; then
  echo "${BASE_URL}/pages/${SLUG}"
else
  echo "Error (HTTP $HTTP_CODE): $RESP_BODY" >&2
  exit 1
fi
