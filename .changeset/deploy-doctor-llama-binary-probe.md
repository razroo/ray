---
"ray": patch
---

Add a strict deploy doctor probe that runs `llama-server --help` to catch wrong-architecture binaries and missing shared libraries before restarting the generated backend service.
