#!/bin/sh

cd $(dirname "$0")/..

echo Init dist
rm -rf dist
mkdir dist

echo Build
npm run build
npm run gen-types

echo Copy files
cp -r package.json LICENSE README.md dist

echo Remove test files
find dist/ -type f -name "*.test.*" -delete

echo Gen exports
npm run gen-exports
