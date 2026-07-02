#!/usr/bin/env sh
set -e

# Build and start the backend from the server directory.
cd server
npm install
npm start
