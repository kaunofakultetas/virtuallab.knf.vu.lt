---
slug: /user-guides/instances
title: My Instances
description: Create and manage your own lab virtual machines.
---

# My Instances

Use **My Instances** to manage the VMs assigned to your account.

## Creating an instance

1. Open **My Instances** from the sidebar.
2. Select **New instance**.
3. Choose a template from the list.
4. Confirm the creation.

If no templates are available, the create button is disabled.

## Instance actions

The action buttons depend on the current VM state:

- **Connect** opens the remote session for a running instance
- **Reboot** restarts a running instance
- **Stop** shuts down a running instance
- **Start** powers on a stopped instance
- **Extend runtime (+3h)** adds three hours to the lease
- **Delete** permanently destroys the VM

## Runtime and expiry

Each instance has a `run_until` timestamp when expiration is enabled. When the time runs out, the instance is treated as expired and may be removed automatically.

## Deleting an instance

Deletion is permanent. It removes the VM and any related remote access entries, so only delete an instance when you are done using it.
