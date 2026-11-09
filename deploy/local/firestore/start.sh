#!/bin/sh
set -eu
case "$FIREBASE_PROJECT_ID" in
  demo-*) ;;
  *) echo 'Firestore emulator requires a demo- project ID' >&2; exit 1 ;;
esac
mkdir -p /data/export
set -- java -Duser.language=en \
  -cp /google-cloud-sdk/platform/cloud-firestore-emulator/cloud-firestore-emulator.jar \
  com.google.cloud.datastore.emulator.firestore.CloudFirestore start \
  --host=0.0.0.0 --port=8080 --database-mode=firestore-native
# Native exports use timestamped subdirectories; import the most recent snapshot.
metadata=$(find /data/export -name '*.overall_export_metadata' -print | sort | tail -n1)
if [ -n "$metadata" ]; then
  set -- "$@" --import-data="$metadata"
fi
"$@" &
emulator_pid=$!
shutdown() {
  trap '' INT TERM
  result=0
  # Export while the server is alive; its Native-mode JVM shutdown hook only stops gRPC.
  curl --fail --silent --show-error --max-time 20 \
    -H 'Content-Type: application/json' -X POST \
    --data "{\"database\":\"projects/$FIREBASE_PROJECT_ID/databases/(default)\",\"export_directory\":\"/data/export\"}" \
    "http://127.0.0.1:8080/emulator/v1/projects/$FIREBASE_PROJECT_ID:export" || result=1
  kill -TERM "$emulator_pid" 2>/dev/null || true
  wait "$emulator_pid" || true
  exit "$result"
}
trap shutdown INT TERM
wait "$emulator_pid"
