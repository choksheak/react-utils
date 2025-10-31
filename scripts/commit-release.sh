#!/bin/sh

cd $(dirname "$0")/..

echo Commit release
V=$(node -p "require('./package.json').version")
git add .
git commit -m "Release $V"
