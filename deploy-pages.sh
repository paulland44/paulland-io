#!/bin/bash
# Deploy paulland.io Pages — excludes Worker subdirectories that break Functions compilation
set -e

TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

rsync -a \
  --exclude='email-to-mis-job' \
  --exclude='mcp-server' \
  --exclude='mcp-worker' \
  --exclude='node_modules' \
  --exclude='.git' \
  --exclude='.claude' \
  . "$TMPDIR/"

npx wrangler pages deploy "$TMPDIR" --project-name=paulland-io --commit-dirty=true
