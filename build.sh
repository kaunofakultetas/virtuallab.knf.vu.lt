#!/bin/bash

docker buildx build \
  --cache-from type=local,src=.docker-cache \
  --cache-to type=local,dest=.docker-cache,mode=max \
  -t virtual-lab-backend \
  --load \
  ./backend
