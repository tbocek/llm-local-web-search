#!/bin/bash
set -e

BUMP_TYPE="${1:-minor}"
CURRENT=$(jq -r '.version' package.json)
IFS='.' read -r MAJOR MINOR <<< "$CURRENT"

if [ "$BUMP_TYPE" = "major" ]; then
  NEW="$((MAJOR + 1)).0"
else
  NEW="${MAJOR}.$((MINOR + 1))"
fi

jq --arg v "$NEW" '.version = $v' package.json > tmp && mv tmp package.json
jq --arg v "$NEW" '.version = $v' src/manifest.json > tmp && mv tmp src/manifest.json

echo "$NEW"