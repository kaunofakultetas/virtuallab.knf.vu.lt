#!/bin/bash

mkdir -p ./_DATA/postgres
chmod 777 ./_DATA/postgres

sudo docker-compose down
sudo docker-compose up -d --build

sudo docker-compose logs --follow
