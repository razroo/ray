---
"@razroo/ray-deploy": patch
---

Add generated systemd `MemorySwapMax` ceilings for the gateway and llama.cpp services so one service cannot consume the whole small-VPS swap cushion.
