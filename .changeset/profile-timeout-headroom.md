---
"@razroo/ray": patch
---

Keep env-only VPS and balanced default scheduler timeouts above their backend adapter timeouts so provider timeout errors remain visible instead of being masked by the gateway timeout.
