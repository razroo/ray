---
"ray": patch
---

Add a strict deploy doctor preflight that verifies the target host is booted with systemd and has `systemctl` before installing generated service units.
