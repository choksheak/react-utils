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
rm dist/*.test.* dist/src/*.test.*

echo Add docs
npm run docs
cp -r docs dist
