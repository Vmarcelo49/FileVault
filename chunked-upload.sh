#!/usr/bin/env bash
# ============================================================
# chunked-upload.sh — Client for chunked uploads to fileTransfer
# Bypasses Cloudflare's 100MB request limit by splitting files.
#
# Usage:
#   ./chunked-upload.sh <local_file> <server_url> [auth_token]
#
# Examples:
#   ./chunked-upload.sh ./big-video.mp4 https://abc.trycloudflare.com
#   ./chunked-upload.sh ./backup.tar.gz https://abc.trycloudflare.com my_secret_token
#
# Environment variables (optional):
#   CHUNK_SIZE    Chunk size in bytes (default: 95MB = 99614720)
#   RESUME        Set to "1" to auto-resume interrupted uploads
# ============================================================
set -euo pipefail

# -------- Config --------
CHUNK_SIZE="${CHUNK_SIZE:-99614720}"   # 95 * 1024 * 1024
RESUME="${RESUME:-0}"

# -------- Args --------
if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <local_file> <server_url> [auth_token] [upload_path]"
  exit 1
fi
LOCAL_FILE="$1"
SERVER_URL="${2%/}"  # remove trailing slash
AUTH_TOKEN="${3:-}"
UPLOAD_PATH="${4:-}"

if [[ ! -f "$LOCAL_FILE" ]]; then
  echo "❌ File not found: $LOCAL_FILE"
  exit 1
fi

# -------- Auth header --------
AUTH_ARGS=()
if [[ -n "$AUTH_TOKEN" ]]; then
  AUTH_ARGS+=(-H "Authorization: Bearer $AUTH_TOKEN")
fi

# -------- File info --------
FILE_SIZE=$(stat -c %s "$LOCAL_FILE" 2>/dev/null || stat -f %z "$LOCAL_FILE")
FILE_NAME=$(basename "$LOCAL_FILE")

# Calculate chunk count
TOTAL_CHUNKS=$(( (FILE_SIZE + CHUNK_SIZE - 1) / CHUNK_SIZE ))
if [[ $TOTAL_CHUNKS -eq 0 ]]; then TOTAL_CHUNKS=1; fi

echo "📦 File:        $FILE_NAME"
echo "📏 Size:        $FILE_SIZE bytes ($(numfmt --to=iec $FILE_SIZE 2>/dev/null || echo "${FILE_SIZE}B"))"
echo "🧩 Chunk size:  $CHUNK_SIZE bytes"
echo "🔢 Total chunks: $TOTAL_CHUNKS"
echo "🌐 Server:      $SERVER_URL"
if [[ -n "$UPLOAD_PATH" ]]; then
echo "📂 Upload Path: /$UPLOAD_PATH"
fi
echo ""

# Generate a unique upload ID
UPLOAD_ID="upl-$(date +%s)-$((RANDOM % 100000))"
echo "🆔 Upload ID: $UPLOAD_ID"

# -------- Step 1: Initialize session --------
echo "▶️  Initializing upload session..."
INIT_RESP=$(curl -sS -X POST "${AUTH_ARGS[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"uploadId\":\"$UPLOAD_ID\",\"fileName\":\"$FILE_NAME\",\"totalSize\":$FILE_SIZE,\"totalChunks\":$TOTAL_CHUNKS,\"path\":\"$UPLOAD_PATH\"}" \
  "${SERVER_URL}/upload/chunk/init")

# FIX: parse JSON with python instead of grep — grep -q '"success":true'
# is brittle and breaks if the server returns the field minified as
# {"success": true} (with space) or with extra whitespace.
if echo "$INIT_RESP" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)" 2>/dev/null; then
  echo "✅ Session initialized"
else
  echo "❌ Init failed: $INIT_RESP"
  exit 1
fi
echo ""

# -------- Step 2: Check resume status (if enabled) --------
START_CHUNK=0
if [[ "$RESUME" == "1" ]]; then
  STATUS_RESP=$(curl -sS "${AUTH_ARGS[@]}" "${SERVER_URL}/upload/chunk/status?uploadId=$UPLOAD_ID")
  RECEIVED=$(echo "$STATUS_RESP" | grep -o '"receivedCount":[0-9]*' | head -1 | cut -d: -f2)
  if [[ -n "$RECEIVED" && "$RECEIVED" -gt 0 ]]; then
    echo "♻️  Resuming: $RECEIVED/$TOTAL_CHUNKS chunks already received"
    START_CHUNK=$RECEIVED
  fi
fi

# -------- Step 3: Upload chunks --------
START_TIME=$(date +%s)
UPLOADED=$START_CHUNK

for ((i = START_CHUNK; i < TOTAL_CHUNKS; i++)); do
  OFFSET=$((i * CHUNK_SIZE))
  
  # Extract chunk using dd (works on Linux + macOS)
  CHUNK_FILE=$(mktemp)
  dd if="$LOCAL_FILE" of="$CHUNK_FILE" bs=$CHUNK_SIZE skip=$i count=1 2>/dev/null
  CHUNK_ACTUAL_SIZE=$(stat -c %s "$CHUNK_FILE" 2>/dev/null || stat -f %z "$CHUNK_FILE")

  PROGRESS=$((i * 100 / TOTAL_CHUNKS))
  printf "\r⬆️  Uploading chunk %d/%d (%d%%) [%s]..." "$((i+1))" "$TOTAL_CHUNKS" "$PROGRESS" "$(numfmt --to=iec $CHUNK_ACTUAL_SIZE 2>/dev/null || echo "${CHUNK_ACTUAL_SIZE}B")"

  RESPONSE=$(curl -sS -X POST "${AUTH_ARGS[@]}" \
    -F "file=@${CHUNK_FILE}" \
    -F "uploadId=${UPLOAD_ID}" \
    -F "chunkIndex=${i}" \
    -F "totalChunks=${TOTAL_CHUNKS}" \
    -F "fileName=${FILE_NAME}" \
    -F "totalSize=${FILE_SIZE}" \
    -F "path=${UPLOAD_PATH}" \
    "${SERVER_URL}/upload/chunk")

  rm -f "$CHUNK_FILE"

  # FIX: parse JSON with python — robust against minified/pretty output
  if echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('success') else 1)" 2>/dev/null; then
    UPLOADED=$((i+1))
    # Check if finalized
    if echo "$RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if d.get('finalized') else 1)" 2>/dev/null; then
      echo ""
      echo ""
      echo "🎉 Upload finalized!"
      echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
      END_TIME=$(date +%s)
      DURATION=$((END_TIME - START_TIME))
      AVG_SPEED=$((FILE_SIZE / (DURATION > 0 ? DURATION : 1)))
      echo ""
      echo "⏱️  Total time: ${DURATION}s"
      echo "🚀 Avg speed: $(numfmt --to=iec $AVG_SPEED 2>/dev/null || echo "${AVG_SPEED}B")/s"
      exit 0
    fi
  else
    echo ""
    echo "❌ Chunk $i failed: $RESPONSE"
    echo "   To resume: $0 $LOCAL_FILE $SERVER_URL ${AUTH_TOKEN:-<token>}"
    echo "   (set RESUME=1 to auto-resume)"
    exit 1
  fi
done

echo ""
echo ""
echo "✅ All $TOTAL_CHUNKS chunks uploaded"
echo "📦 File should be available at: ${SERVER_URL}/files/${FILE_NAME// /_}"
