#!/usr/bin/env sh
set -e

cd "$(dirname "$0")"
npm install
npm run build
cd api
npm install
node score.js
