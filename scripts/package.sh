#!/bin/sh

cd $(dirname "$0")/..

echo Init dist
rm -rf dist
mkdir dist

echo Build
npm run build
npm run gen-types

echo Copy files
cp -r package.json LICENSE README.md src dist

echo Remove test files
find dist/ -type f -name "*.test.*" -delete

echo Gen exports
npm run gen-exports

echo Add docs
npm run docs
cp -r docs dist
