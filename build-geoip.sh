#!/bin/bash
# Build the GeoIP database used by CrowdSieve: download DB-IP City Lite
# (MMDB format, IPv4 + IPv6, CC BY 4.0, no account required) into
# ./geoip/geoip-city.mmdb, where docker-compose.yml expects it.
#
# Usage: ./build-geoip.sh [--force]
#
# The current month's edition is tried first, then the previous one (the new
# edition is published during the first days of the month). Without --force,
# an existing database from the current month is kept.
# https://db-ip.com/db/download/ip-to-city-lite

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
GEOIP_DIR=${GEOIP_DIR:-$SCRIPT_DIR/geoip}
OUTPUT=$GEOIP_DIR/geoip-city.mmdb
FORCE=0
[ "${1:-}" = --force ] && FORCE=1

CURRENT=$(date +%Y-%m)
PREVIOUS=$(date -d "$(date +%Y-%m-01) -1 month" +%Y-%m)

if [ "$FORCE" = 0 ] && [ -s "$OUTPUT" ] && [ "$(date -r "$OUTPUT" +%Y-%m)" = "$CURRENT" ]; then
    echo "$OUTPUT is up to date (use --force to download it again)"
    exit 0
fi

mkdir -p "$GEOIP_DIR"
TMP=$OUTPUT.part
trap 'rm -f "$TMP"' EXIT

for MONTH in "$CURRENT" "$PREVIOUS"; do
    URL="https://download.db-ip.com/free/dbip-city-lite-$MONTH.mmdb.gz"
    echo "Downloading DB-IP City Lite $MONTH..."
    if curl -fsSL "$URL" | gunzip >"$TMP" 2>/dev/null && [ -s "$TMP" ]; then
        # An MMDB file ends with a metadata section starting with this marker
        if ! tail -c 200000 "$TMP" | grep -aq 'MaxMind.com'; then
            echo "Downloaded file is not a valid MMDB database" >&2
            exit 1
        fi
        chmod 644 "$TMP"
        mv -f "$TMP" "$OUTPUT"
        echo "GeoIP database ready: $OUTPUT ($(du -h "$OUTPUT" | cut -f1), DB-IP $MONTH)"
        exit 0
    fi
    echo "  not available" >&2
done

echo "Error: could not download DB-IP City Lite" >&2
exit 1
