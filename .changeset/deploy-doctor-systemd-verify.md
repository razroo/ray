---
"@razroo/ray": patch
---

Repo-only: verify generated systemd unit files with systemd-analyze during strict deploy doctor runs so unsupported directives or unit syntax fail before installing or restarting Ray services on a VPS.
