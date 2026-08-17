---
slug: /operations
title: Operations
description: Running, rebuilding and recovering the lab infrastructure.
---

# Operations

Procedures for the people who run the lab rather than use it.

- [Production rebuild](/operations/production-rebuild) — rebuilding a Proxmox
  host from bare metal through to verified network isolation. Doubles as the
  disaster-recovery procedure.
- [Architecture](/architecture) — what the stack is made of and how the network
  policy works, for when a runbook step needs context.

Supporting scripts live in `infra/prod-migration/`:

| Script | Does |
| --- | --- |
| `inventory.sh` | Read-only survey of a host before any change |
| `prepare-backup-disk.sh` | Partitions and mounts a new disk, refusing anything in use |
| `backup-before-reinstall.sh` | Dumps every guest plus host configuration, verified and resumable |
