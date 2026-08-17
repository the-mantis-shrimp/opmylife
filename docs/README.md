# Documentation

All project docs live here. Start with the spec that covers your task; `../CLAUDE.md` is the session entry point and holds the locked decisions.

## Product & design
| Doc | What it covers |
|---|---|
| [product-spec.md](./product-spec.md) | What we're building, the user journey, scope, non-goals |
| [architecture.md](./architecture.md) | System shape, repo layout, the sync→async boundary |
| [data-model.md](./data-model.md) | Postgres schema — tables, enums, relationships |
| [pipeline.md](./pipeline.md) | Per-step pipeline contracts, consent branch, beat-sync, charge point |
| [build-plan.md](./build-plan.md) | Build history — how it was shipped, phase by phase, with the remaining backlog |

## Deploy & operate
| Doc | What it covers |
|---|---|
| [setup.md](./setup.md) | Step-by-step going-live guide: hosting accounts + third-party integrations |
| [railway-deployment-topology.md](./railway-deployment-topology.md) | Services, env vars, private networking, setup order |
| [scaling-and-resources.md](./scaling-and-resources.md) | CPU/RAM limits, replicas, worker concurrency, env→branch mapping, scaling triggers |
| [gallery-assets.md](./gallery-assets.md) | Persistent demo videos: dedicated public R2 bucket, upload + wiring |

## Policy
| Doc | What it covers |
|---|---|
| [privacy-and-consent.md](./privacy-and-consent.md) | Consent gate, biometric handling, TTL, exact privacy wording |

> Note: this is a public portfolio copy. Some operational docs (billing/margin
> model, trust-&-safety runbook, cost tracking) are kept in a private repo.
