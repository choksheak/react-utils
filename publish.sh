#!/bin/sh

cd $(dirname "$0")

echo Bump version
npm run bump

echo CI
npm run ci

echo Generate types
npm run gen-types

echo Copy files
cp -r package.json LICENSE README.md src dist

echo Remove test files
rm dist/*.test.* dist/src/*.test.*

echo Add docs
npm run docs
cp -r docs dist

echo Publish
cd dist
npm publish --access=public

echo Commit
cd ..
V=$(node -p "require('./package.json').version")
git add .
git commit -m "Release $V"
