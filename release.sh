#!/bin/bash
set -eu

# Check git status
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    echo "Error: Not in a git repository"
    exit 1
fi

if [[ -n $(git status --porcelain) ]]; then
    echo "Error: Uncommitted changes. Commit first."
    git status --porcelain
    exit 1
fi

CURRENT=$(jq -r '.version' package.json)
NEW=$((CURRENT + 1))

jq --arg v "$NEW" '.version = $v' package.json > tmp && mv tmp package.json
jq --arg v "$NEW" '.version = $v' src/manifest.json > tmp && mv tmp src/manifest.json

git add package.json src/manifest.json
git commit -m "Release v$NEW"
git tag "v$NEW"
git push && git push --tags

echo "Released v$NEW"