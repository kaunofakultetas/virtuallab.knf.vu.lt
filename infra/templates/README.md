# Templates

Documentation for preparing VM images for use as lab templates.

| Guide | Cleanup script | Tested on |
|---|---|---|
| [linux.md](./linux.md) | `linux_cleanup.sh` | Kali Linux |
| [windows.md](./windows.md) | `windows_cleanup.ps1` | Windows 10/11, Windows Server 2019/2022 |

## ID conventions

| Range | Purpose | Tag |
|---|---|---|
| 100s | Build images (keep, modify freely) | `build_image` |
| 9000s | Template images (read-only after conversion) | `template_image` |
| 10000+ | Student instances (managed by the system) | — |
