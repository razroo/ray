---
"@razroo/ray": patch
---

Repo-only: fail deploy doctor when async queue storage is configured under systemd ProtectSystem read-only roots so durable job writes are kept in service-writable state such as /var/lib/ray/async-queue.
