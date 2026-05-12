---
"@razroo/ray": patch
---

Repo-only: make `model:stage --check-sources` run a bounded `llama-server --help` probe against the source binary so wrong-architecture or broken local binaries fail before operators review or apply staging commands.
