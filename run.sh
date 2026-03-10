#!/bin/bash

set -e

docker build -t dunk-discord-antispam .
docker stop dunk-discord-antispam || true
docker rm dunk-discord-antispam || true

docker run --init -d \
  --restart unless-stopped \
  -v "$PWD/config.json:/bot/config.json" \
  -v "$PWD/secrets.json:/bot/secrets.json" \
  --name dunk-discord-antispam \
  dunk-discord-antispam
