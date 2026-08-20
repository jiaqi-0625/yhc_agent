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

## Product model and workflow invariants

- Use the hierarchy `tenant -> brand -> vehicle -> batch project -> video task`; do not collapse a batch project and a video task into one entity.
- Only administrators maintain brands, vehicles, official vehicle facts, and company-asset associations. Authorized production accounts create batch projects and video tasks.
- A batch project is scoped to one vehicle and one aspect ratio. The server generates its name; the creation page does not ask the production account for a custom batch name.
- Project-level settings are the vehicle, available asset pool, visual style, and aspect ratio. Audience, theme, duration, script input, and platform tags belong to a video task.
- Platform selections are metadata tags only in the current product scope; they do not alter generation rules.
- Company assets are read-only through a replaceable provider interface. Vehicle assets cannot be swapped across vehicles; people and scenes may be replaced from the company catalog.
- The Agent selects people and scenes during asset matching from administrator-authored asset descriptions. Storyboard shots display their referenced assets and allow human replacement of people and scenes; human edits always win.
- The project asset pool tracks the latest catalog data, but every video task must lock versioned vehicle and asset snapshots when strategy work starts.
- Local uploads belong to a project-scoped temporary asset pool. Validate format, dimensions, duplicates, source, and usage rights before they can be used.
- The video workflow is `strategy -> asset matching -> script -> storyboard -> video preview -> delivery`. Every stage requires an explicit human confirmation.
- Persist an immutable version at every confirmation. Rolling back a version must invalidate all dependent downstream artifacts.
- One account may run at most one expensive video-production job at a time. Different accounts may each run one job. Enforce this on the server.
- Every video task has one active owner. Other authorized project members may view or take over the task, but concurrent ownership is not allowed.
- Enforce per-account budgets on the server and show estimated cost before an expensive operation.
- The Agent may propose domain action cards, but state changes, approvals, and expensive operations require an explicit user action.
- The desktop workspace uses top-level functional modules, a left project/task/asset rail, a central work surface, and a task-scoped Agent panel. Each video task owns its own progress state.

The confirmed product and implementation specification is in `docs/workspace-v2-product-spec.md`. Treat it as the source of truth for Workspace V2 unless a later decision record explicitly supersedes it.

## Active development tracking and repository maintenance

- The workspace track is maintained in `docs/plans/workspace-track-todo.md`.
- The task-scoped Agent/dialog track is maintained in `docs/plans/agent-dialog-track-todo.md`.
- Treat these files as live execution ledgers. Before starting work, synchronize local `main` with `origin/main`, then update the active task, status, date, target branch, and latest commit; update them again after every push, block, or review transition.
- Use the stable task IDs from the ledgers in commit messages when practical.
- The standing repository workflow is direct-to-`main`: work from the latest `origin/main`, keep commits task-scoped, run the relevant checks, and push by non-forced fast-forward. Create a feature branch or PR only when the user explicitly asks.
- Do not mark a task complete until its commits are present on `origin/main`, relevant automated checks pass, and the documented acceptance check has been performed.
- Keep `main` runnable and never mix unrelated track work into one commit.
- The workspace owner has final maintenance responsibility for shared business schemas and domain transitions. The dialog owner must propose shared contract changes for review instead of creating a parallel type or bypassing the domain layer.
- Split shared monolith files before sustained parallel work. Until `apps/api/src/server.ts` and the Web `app.js`/`app.css`/`index.html` surfaces are modularized, coordinate edit order explicitly in both ledgers.
- When a shared Schema, workflow state, API contract, or product boundary changes, update both ledgers and the affected source-of-truth document in the same main-bound commit series.
- Record blockers in the relevant ledger on the day they are discovered, including the owner, required decision, and condition for unblocking.

## Engineering rules

- Use Node.js 22.19 or newer and strict TypeScript.
- Pin direct dependency versions.
- Use `apply_patch` for source edits.
- Add focused tests for every state transition, policy decision, and tool boundary.
- Use mock providers in automated tests. CI must not spend real model credits.
- Run `npm run check` after code changes.
- The user has granted standing authorization to commit and push completed in-scope work directly to `main` after checks pass. Do not publish to another branch, open a PR, or force-push `main` unless the user explicitly asks.

## Repository structure

- `apps/api`: HTTP/SSE boundary for the product UI.
- `packages/schemas`: versioned contracts shared by UI, API, agent, tools, and tests.
- `packages/domain`: workflow state machine, policy, version, and approval rules.
- `packages/tools`: whitelisted domain tools and service adapters.
- `packages/agent`: Pi Agent Core configuration and system behavior.
- `docs`: architecture and decision records.
