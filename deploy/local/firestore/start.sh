#!/bin/sh
set -eu
case "$FIREBASE_PROJECT_ID" in
  demo-*) ;;
  *) echo 'Firestore emulator requires a demo- project ID' >&2; exit 1 ;;
esac
set -- gcloud emulators firestore start --host-port=0.0.0.0:8080 \
  --project="$FIREBASE_PROJECT_ID" --export-on-exit=/data/export
metadata=$(find /data -name '*.overall_export_metadata' -print -quit)
if [ -n "$metadata" ]; then
  set -- "$@" --import-data="$metadata"
fi
exec "$@"
