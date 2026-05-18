#!/bin/bash

sudo touch CaddyAccess.log

mkdir -p ./_DATA/postgres
sudo chmod 777 ./_DATA/postgres

sudo docker compose down
sudo docker compose up -d --build

sudo docker compose logs --follow
