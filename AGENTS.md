# Firefly Ad Agent Development Rules

## Purpose

This repository implements an automotive information-feed advertising production agent. The product creates advertising assets; it does not publish ads or manage media buying.

## Non-negotiable boundaries

- Treat the workflow state machine as the business source of truth. Conversation history is not authoritative business state.
- Register only domain-specific tools. Never expose generic shell, filesystem, SQL, arbitrary HTTP, or browser tools to the production agent.
- Resolve actor, project, tenant, and brand scope from the authenticated session. Never trust identity fields proposed by the model.
- Enforce permissions, workflow state, budget, idempotency, and human approvals in code before executing tools.
- Vehicle facts come only from a versioned vehicle snapshot. Model-generated claims are not official facts.
- Human edits and locked fields always win over model output.
- The model may request approval but may not approve its own work.
- Keep real credentials out of files, logs, prompts, tool results, tests, and fixtures.
- External model output must pass a versioned schema before persistence.

## Engineering rules

- Use Node.js 22.19 or newer and strict TypeScript.
- Pin direct dependency versions.
- Use `apply_patch` for source edits.
- Add focused tests for every state transition, policy decision, and tool boundary.
- Use mock providers in automated tests. CI must not spend real model credits.
- Run `npm run check` after code changes.
- Do not commit or push unless the user explicitly asks.

## Repository structure

- `apps/api`: HTTP/SSE boundary for the product UI.
- `packages/schemas`: versioned contracts shared by UI, API, agent, tools, and tests.
- `packages/domain`: workflow state machine, policy, version, and approval rules.
- `packages/tools`: whitelisted domain tools and service adapters.
- `packages/agent`: Pi Agent Core configuration and system behavior.
- `docs`: architecture and decision records.
