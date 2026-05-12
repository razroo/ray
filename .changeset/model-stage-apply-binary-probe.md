---
"@razroo/ray": patch
---

Repo-only: make `model:stage --apply` run the staged `llama-server --help` startup probe as the generated service identity before copying the GGUF, catching invalid binaries during apply mode instead of only in the printed command plan.
