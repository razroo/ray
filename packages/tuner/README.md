# @razroo/ray-tuner

VPS-safe llama.cpp tuning helpers for Ray deployments.

```ts
import { createLlamaTunerCandidates, recommendLlamaTunerCandidate } from "@razroo/ray-tuner";
```

Use this package to generate bounded llama.cpp launch candidates for a specific VPS and select the fastest stable profile from benchmark observations.
