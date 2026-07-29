#!/usr/bin/env bash
set -euo pipefail
# swap-upstream.sh — swap primary ↔ backup upstream, then restart Lens

SERVICE_FILE="/etc/systemd/system/lens.service"
TEMP_FILE=$(mktemp)

trap 'rm -f "$TEMP_FILE"' EXIT

# Read current environment variables
upstream=$(grep -oP '^Environment=UPSTREAM_BASE_URL=\K.*' "$SERVICE_FILE")
api_key=$(grep -oP '^Environment=API_KEY=\K.*' "$SERVICE_FILE")
backup_url=$(grep -oP '^Environment=BACKUP_UPSTREAM_BASE_URL=\K.*' "$SERVICE_FILE" || true)
backup_key=$(grep -oP '^Environment=BACKUP_API_KEY=\K.*' "$SERVICE_FILE" || true)

if [ -z "$backup_url" ]; then
    echo "ERROR: No backup upstream configured — nothing to swap with." >&2
    exit 1
fi

echo "Swapping..."
echo "  Primary:   $upstream  →  $backup_url"
echo "  Backup:    $backup_url  →  $upstream"
echo "  Restarting Lens..."

# Build new service file with swapped values
sed \
    -e "s|^Environment=UPSTREAM_BASE_URL=.*|Environment=UPSTREAM_BASE_URL=$backup_url|" \
    -e "s|^Environment=BACKUP_UPSTREAM_BASE_URL=.*|Environment=BACKUP_UPSTREAM_BASE_URL=$upstream|" \
    -e "s|^Environment=API_KEY=.*|Environment=API_KEY=$backup_key|" \
    -e "s|^Environment=BACKUP_API_KEY=.*|Environment=BACKUP_API_KEY=$api_key|" \
    "$SERVICE_FILE" > "$TEMP_FILE"

# Validate the result: ensure both UPSTREAM_BASE_URL and API_KEY are still present
if ! grep -q '^Environment=UPSTREAM_BASE_URL=' "$TEMP_FILE" || ! grep -q '^Environment=API_KEY=' "$TEMP_FILE"; then
    echo "ERROR: Generated config is broken — aborting." >&2
    exit 1
fi

cp "$TEMP_FILE" "$SERVICE_FILE"
systemctl daemon-reload
systemctl restart lens

sleep 1
if systemctl is-active --quiet lens; then
    echo "✅ Lens restarted — upstream swapped."
    echo "   New primary: $backup_url"
    echo "   New backup:  $upstream"
else
    echo "❌ Lens failed to restart!" >&2
    systemctl --no-pager status lens 2>&1 | head -10
    exit 1
fi
