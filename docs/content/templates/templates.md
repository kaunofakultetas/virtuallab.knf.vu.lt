---
slug: /templates
title: VM Templates
description: Documentation for preparing VM images for use as lab templates.
---

# Templates

Documentation for preparing VM images for use as lab templates.

| Guide | Cleanup script | Tested on |
|---|---|---|
| [Linux](/templates/linux) | [linux_cleanup.sh](https://github.com/kaunofakultetas/virtuallab.knf.vu.lt/blob/main/infra/templates/linux_cleanup.sh) | Kali Linux |
| [Windows](/templates/windows) | [windows_cleanup.ps1](https://github.com/kaunofakultetas/virtuallab.knf.vu.lt/blob/main/infra/templates/windows_cleanup.ps1) | Windows 10/11, Windows Server 2019/2022 |

## ID conventions

| Range | Purpose | Tag |
|---|---|---|
| 100s | Build images (keep, modify freely) | `build_image` |
| 9000s | Template images (read-only after conversion) | `template_image` |
| 10000+ | Student instances (managed by the system) | — |

## Related guides

- [Linux template guide](/templates/linux)
- [Windows template guide](/templates/windows)
- [Guacamole setup](/setup/guacamole)
