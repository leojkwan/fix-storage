#!/usr/bin/env bash
# Fixture: some producer fails, so the doctor exits 1 but still prints valid JSON.
cat "$(dirname "$0")/../../doctor-fail.json"
exit 1
