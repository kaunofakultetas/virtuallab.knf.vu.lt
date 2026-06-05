#!/bin/bash

sudo touch CaddyAccess.log

mkdir -p ./_DATA/postgres
mkdir -p ./_DATA/caddy_logs
sudo touch ./_DATA/caddy_logs/access.log
sudo chmod 777 ./_DATA/caddy_logs/access.log
sudo chmod 777 ./_DATA/caddy_logs
sudo chmod 777 ./_DATA/postgres

sudo docker compose down
sudo docker compose up -d --build

sudo docker compose logs --follow
