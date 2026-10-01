#!/bin/bash
# Export the CrowdSieve PostgreSQL database (Kubernetes) to a SQLite file
# usable by CrowdSieve (STORAGE_TYPE=sqlite), without LemonLDAP::NG
# BAD_CREDENTIALS alerts.
#
# Steps: kubectl cp extract.mjs into a running CrowdSieve pod, run it there
# (it uses the pod's POSTGRES_* env, `pg` and `better-sqlite3`), gzip the
# result, kubectl cp it back, check its sha256, clean up the pod.
#
# Usage:
#   ./export.sh [options] [output.db]      (default output: crowdsieve-YYYYMMDD.db)
#   ./export.sh --inspect                  (show what would be excluded, write nothing)
#
# Options:
#   --context CTX          kubectl context (default: prod-hosting)
#   -n, --namespace NS     namespace (default: crowdsieve)
#   --pod POD              pod to use (default: first running crowdsieve pod)
#   --exclude-where SQL    PostgreSQL predicate on alerts alias `a` selecting the
#                          alerts to drop (default: LemonLDAP::NG BAD_CREDENTIALS)
#   --no-exclude           keep every alert
#   --force                overwrite the output file

set -euo pipefail

CONTEXT=prod-hosting
NAMESPACE=crowdsieve
CONTAINER=crowdsieve
POD=
INSPECT=0
FORCE=0
OUTPUT=
EXTRACT_ARGS=()
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REMOTE_DIR=/tmp/crowdsieve-export-$$

usage() {
    sed -n '2,/^$/{s/^# \{0,1\}//;p}' "$0"
    exit "${1:-0}"
}

while [ $# -gt 0 ]; do
    case "$1" in
        --context) CONTEXT=$2; shift 2 ;;
        -n|--namespace) NAMESPACE=$2; shift 2 ;;
        --pod) POD=$2; shift 2 ;;
        --exclude-where) EXTRACT_ARGS+=(--exclude-where "$2"); shift 2 ;;
        --no-exclude) EXTRACT_ARGS+=(--no-exclude); shift ;;
        --inspect) INSPECT=1; shift ;;
        --force) FORCE=1; shift ;;
        -h|--help) usage ;;
        -*) echo "Unknown option: $1" >&2; usage 1 ;;
        *) OUTPUT=$1; shift ;;
    esac
done

OUTPUT=${OUTPUT:-crowdsieve-$(date +%Y%m%d).db}
if [ "$INSPECT" = 0 ] && [ -e "$OUTPUT" ] && [ "$FORCE" = 0 ]; then
    echo "$OUTPUT already exists (use --force to overwrite)" >&2
    exit 1
fi

KUBECTL=(kubectl --context "$CONTEXT" -n "$NAMESPACE")

# Pick a running CrowdSieve pod (not the crowdsieve-lapi ones)
if [ -z "$POD" ]; then
    POD=$("${KUBECTL[@]}" get pods --field-selector=status.phase=Running \
        -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.spec.containers[*].name}{"\n"}{end}' |
        awk -v c="$CONTAINER" '$1 !~ /-lapi-/ { for (i = 2; i <= NF; i++) if ($i == c) { print $1; exit } }')
    if [ -z "$POD" ]; then
        echo "No running pod with a '$CONTAINER' container in $NAMESPACE" >&2
        exit 1
    fi
fi
echo "Using pod $NAMESPACE/$POD (context $CONTEXT)" >&2

kexec() {
    "${KUBECTL[@]}" exec "$POD" -c "$CONTAINER" -- "$@"
}

cleanup() {
    kexec rm -rf "$REMOTE_DIR" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# 1. Deploy the extractor (always re-copied: the pod may have been restarted)
kexec mkdir -p "$REMOTE_DIR"
"${KUBECTL[@]}" cp -c "$CONTAINER" "$SCRIPT_DIR/extract.mjs" "$POD:$REMOTE_DIR/extract.mjs"

if [ "$INSPECT" = 1 ]; then
    kexec node "$REMOTE_DIR/extract.mjs" --inspect "${EXTRACT_ARGS[@]}"
    exit 0
fi

# 2. Run the extraction in the pod
echo "Extracting (PostgreSQL -> SQLite) in the pod..." >&2
kexec node "$REMOTE_DIR/extract.mjs" --output "$REMOTE_DIR/crowdsieve.db" "${EXTRACT_ARGS[@]}"

echo "Compressing..." >&2
kexec gzip -f "$REMOTE_DIR/crowdsieve.db"
REMOTE_SUM=$(kexec sha256sum "$REMOTE_DIR/crowdsieve.db.gz" | awk '{print $1}')

# 3. Bring it back
echo "Downloading..." >&2
TMP_GZ="$OUTPUT.gz.part"
rm -f "$TMP_GZ"
"${KUBECTL[@]}" cp --retries=5 -c "$CONTAINER" "$POD:$REMOTE_DIR/crowdsieve.db.gz" "$TMP_GZ"

LOCAL_SUM=$(sha256sum "$TMP_GZ" | awk '{print $1}')
if [ "$LOCAL_SUM" != "$REMOTE_SUM" ]; then
    rm -f "$TMP_GZ"
    echo "Checksum mismatch after download, aborting" >&2
    exit 1
fi

gunzip -c "$TMP_GZ" >"$OUTPUT.part"
rm -f "$TMP_GZ"
if command -v sqlite3 >/dev/null; then
    CHECK=$(sqlite3 "$OUTPUT.part" 'PRAGMA integrity_check')
    if [ "$CHECK" != ok ]; then
        echo "SQLite integrity check failed: $CHECK" >&2
        exit 1
    fi
fi
mv -f "$OUTPUT.part" "$OUTPUT"

echo "Done: $OUTPUT ($(du -h "$OUTPUT" | cut -f1))" >&2
