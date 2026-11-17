#!/usr/bin/env bash
# Fixture: exit 2 means the doctor itself broke, even if it printed JSON.
cat "$(dirname "$0")/../../doctor-fail.json"
exit 2
