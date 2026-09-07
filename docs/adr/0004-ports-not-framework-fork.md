# ADR 0004 — Narrow model/channel/effect ports, no framework fork

Status: accepted for M0.

Own the domain journal, work state and deterministic action gate. Model providers,
transport bindings and effect executors remain adapters. Do not reproduce a whole
coding-agent harness or fork a multichannel gateway to obtain these few properties.

Pi remains a candidate inside the Planner adapter, not the authoritative store or
permission system. Compatibility with its current tool-call lifecycle must be
proven when that adapter is implemented. No Pi runtime dependency ships in M0.

A port is a TypeScript contract, not authentication, isolation or a completed
platform integration. These capabilities must be documented separately.
