#!/bin/sh

cd $(dirname "$0")

echo CI
npm run ci

echo Generate types
npm run gen-types

echo Bump version
npm run bump

echo Copy files
rm -rf dist
mkdir dist
cp -r package.json LICENSE README.md src dist

echo Remove test files
rm dist/*.test.* dist/src/*.test.*

echo Add docs
npm run docs
cp -r docs dist

echo Publish
npm publish --access=public dist

echo Commit
V=$(node -p "require('./package.json').version")
git add .
git commit -m "Release $V"
