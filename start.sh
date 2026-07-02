#!/usr/bin/env sh
set -e

cd "$(dirname "$0")"
npm install
npm run build
cd server
npm install
npm start
