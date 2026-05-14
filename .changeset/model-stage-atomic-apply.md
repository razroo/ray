---
---

Repo-only: make model-stage apply write verified llama.cpp and GGUF artifacts through same-directory temporary files before renaming them into place, avoiding partial live artifacts and final-path symlink overwrites on VPS deploys.
