# Roadmap

## Phase 1: Single-Node VPS Inference Runtime

Goal: make one cheap VPS a credible place to host smaller AI models.

Scope:

- stable gateway API
- JSON config profiles
- OpenAI-compatible local backend adapter
- backend-aware health and readiness checks
- bounded queueing and concurrency controls
- in-memory prompt/result cache
- request deduplication
- systemd and reverse proxy deployment path
- lightweight metrics and structured logs

Exit criteria:

- local dev and VPS deployment are both straightforward
- one operator can deploy and reason about the runtime without extra control-plane software
- the runtime remains lean enough to fit the repo thesis
- the project already feels more like a small-model runtime than a generic provider wrapper

## Phase 2: Better Model Optimization And Caching

Goal: make constrained hardware feel less constrained.

Scope:

- first-class `llama.cpp` and GGUF-oriented adapter depth
- stronger cache policy and cache key tuning
- warm-start hooks and lightweight preload behavior
- quantization-aware adapter metadata
- backend capability detection
- memory-aware concurrency and scheduling defaults
- smarter degradation policy under pressure

Exit criteria:

- repeated or similar workloads cost less
- operators can tune for memory, speed, or latency with clearer tradeoffs
- local-backend operations are first-class, not incidental

## Phase 3: Multi-Model Routing And Smarter Scheduling

Goal: support multiple small models on the same node without turning the runtime into a mess.

Scope:

- multiple configured backends
- route-by-task or route-by-policy support
- priority-aware scheduling
- lightweight batching where it actually helps
- admission control improvements

Exit criteria:

- Ray can manage more than one useful model on a single machine
- routing logic stays understandable and operationally cheap
- multi-model support still feels like single-node software, not a disguised cluster product

## Phase 4: Distributed Or Edge-Aware Deployment

Goal: expand beyond one node without importing premature platform complexity.

Scope:

- optional remote node registration
- edge-aware placement hints
- low-friction replication patterns
- simple node-level health and failover primitives

Exit criteria:

- distributed operation is additive, not mandatory
- the single-node story stays first-class
- the distributed layer does not drag the core runtime into enterprise bloat

## Phase 5: Deeper Integration With `iso`

Goal: connect the AI runtime cleanly into the larger sovereignty stack.

Scope:

- shared environment and deployment primitives
- host/runtime policy integration
- provisioning hooks
- operator workflows that span runtime and environment layers

Exit criteria:

- Ray remains a sharp subsystem instead of becoming a generic platform wrapper
- the integration reduces operational friction without hiding how the runtime behaves
