# Firefly Local Ad Agent Framework

Local-first Agent framework built on Pi Agent Core for the automotive information-feed advertising product. The repository now includes a credential-free first business vertical slice from an immutable vehicle snapshot to a versioned strategy draft and human approval.

## Current capability

- Versioned schemas for projects, vehicle snapshots, claims, and work state.
- Explicit workflow transitions with approval gates.
- Tool allowlisting and pre-execution policy checks.
- Reusable Pi `createBaseAgent` factory with an empty default toolset.
- Credential-free deterministic Mock provider for local development and CI.
- Configuration adapters for DeepSeek V4 and Volcengine Ark OpenAI-compatible models.
- Persistent local conversations, transcript recovery, reset, cancellation, and normalized lifecycle events.
- Interactive CLI, local browser acceptance page, and HTTP session endpoints.
- Persistent business works stored separately from Agent transcripts.
- A built-in fictional golden vehicle sample with sourced fixed/extended claims and prohibited expressions.
- Versioned strategy generation, validation, human editing/locking, regeneration, approval request, rejection, and approval.
- Agent tools propose strategy generation or approval through explicit action cards; only read-only validation runs directly, and the model has no approval-decision tool.
- Restricted vehicle snapshot and claim validation tools remain available as a separate optional business assembly.
- Unit and integration tests that require no model credentials.

The default chat runtime still has no domain tools and does not call a paid model. The local acceptance page exercises the strategy vertical through bounded business APIs and a deterministic strategy generator. It does not publish ads, mutate an official vehicle catalog, spend media budget, or perform image/video generation.

## Requirements

- Node.js 22.19 or newer.
- npm 10 or newer.
- PostgreSQL 18 only when exercising the retained PostgreSQL adapter (CI uses PostgreSQL 18.4).

## Install

```powershell
npm install --ignore-scripts
```

## Validate

```powershell
npm run check
```

PostgreSQL integration checks use a dedicated `TEST_DATABASE_URL` and run separately:

```powershell
$env:POSTGRES_TEST_ALLOW_SCHEMA_RESET = "true"
npm run test:postgres
Remove-Item Env:POSTGRES_TEST_ALLOW_SCHEMA_RESET
```

The integration command deliberately resets `public`; it refuses to run unless the database name ends in `_test` and the explicit reset opt-in is present.

The check command runs strict TypeScript validation, automated tests, and a local credential-pattern scan.

Production dependency audit:

```powershell
npm run audit:prod
```

## Run locally without a model key

### Current local persistence

The current development and acceptance runtime uses the local Workspace V2 file Stores. Projects, tasks, approvals, assets, budgets and Agent task context must work without a database; authenticated V2 Agent sessions never fall back to the legacy `.data/works` Store. Agent transcripts remain isolated conversation storage and are not business authority.

Copy the example configuration and start the API. `PERSISTENCE_BACKEND` defaults to `local` in development:

```powershell
Copy-Item .env.example .env
npm run dev:api
```

### Exercise the retained PostgreSQL adapter

PostgreSQL support remains available for explicit adapter and migration verification, but is not the current product runtime. Before enabling it, provide a disposable or approved database, apply migrations explicitly, and bootstrap persisted administration data; ordinary reads do not inject demo brands, vehicles or grants.

Create an ignored `.env`, set a private `POSTGRES_PASSWORD`, and set `DATABASE_URL` to the matching connection URI. Docker exposes the local PostgreSQL 18.4 service only on loopback:

```powershell
Copy-Item .env.example .env
# Edit .env locally. Never commit DATABASE_URL or POSTGRES_PASSWORD.
docker compose -f compose.postgres.yml up -d
npm run db:migrate
npm run db:status
```

PostgreSQL startup never applies DDL. Run `npm run db:migrate` as an explicit deployment step; the adapter fails closed when the database cannot be reached or its required schema is incompatible. Missing administration bootstrap data remains an empty, unauthorized business state instead of being silently filled from process constants. `NODE_ENV=production` still requires an explicit `PERSISTENCE_BACKEND=postgres`; that path is not considered re-enabled until the migration, identity and release plan is approved. `GET /health` is liveness-only. With PostgreSQL selected, `GET /ready` verifies the database and schema without returning connection details.

Production identity-provider wiring is separate from database persistence. Development-account session issuance remains disabled under `NODE_ENV=production`. V2 project/task selection and `TaskContext` integration are verified independently; they must not recover business state by reading `.data/works`.

Interactive CLI:

```powershell
npm run dev:cli
```

Available commands: `/status`, `/reset`, `/new`, and `/exit`. Conversations are stored under `.data/sessions` by default. Resume a named session with:

```powershell
npm run dev:cli -- --session=demo_session
```

Local API:

```powershell
npm run dev:api
```

The development command watches source files and automatically restarts the local API after changes. Use `npm run start:api` when a non-watching process is preferred.

After the server starts, open the local acceptance page:

```text
http://127.0.0.1:3100/
```

With the default local backend, the page uses authenticated Workspace V2 project, task, session, and Agent endpoints backed by local V2 Stores. On a loopback host with `NODE_ENV=development`, the development-account switcher may issue a workspace Session; it is disabled in production. Agent runs require a selected V2 video task and never fall back to `.data/works`. The main Agent defaults to DeepSeek; without a server-side key the UI remains available for diagnostics while model calls fail closed and never fall back to Mock.

Workspace V2 endpoints include:

- `GET http://127.0.0.1:3100/health`
- `GET http://127.0.0.1:3100/ready`
- `GET http://127.0.0.1:3100/v1/meta`
- `POST http://127.0.0.1:3100/v1/auth/session` (loopback development only)
- `GET http://127.0.0.1:3100/v1/workspace/project-library`
- `GET http://127.0.0.1:3100/v1/workspace/project-creation/options`
- `POST http://127.0.0.1:3100/v1/workspace/batch-projects`
- `POST http://127.0.0.1:3100/v1/workspace/batch-projects/{projectId}/video-tasks`
- `POST http://127.0.0.1:3100/v1/sessions` with `{ "videoTaskId": "..." }`
- `POST http://127.0.0.1:3100/v1/sessions/{sessionId}/runs?videoTaskId=...`
- `GET http://127.0.0.1:3100/v1/sessions/{sessionId}/runs/{runId}/events?videoTaskId=...`
- `GET http://127.0.0.1:3100/v1/sessions/{sessionId}/transcript?videoTaskId=...`

Except for health, metadata, and the loopback development login, these routes require `Authorization: Bearer <workspace-session-token>`. For example:

```powershell
$login = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3100/v1/auth/session `
  -ContentType application/json -Body '{"accountId":"account_creator_a"}'
$headers = @{ Authorization = "Bearer $($login.session.token)" }
Invoke-RestMethod -Headers $headers -Uri http://127.0.0.1:3100/v1/workspace/project-library
```

The following V1 endpoints are compatibility reads only in the configured local application. V1 writes return `410`; the Agent and Workspace V2 must not use them as a task-context or migration fallback:

- `GET http://127.0.0.1:3100/v1/works`
- `GET http://127.0.0.1:3100/v1/works/{id}`

Set `PORT` to use a different port.

## Connect a real model

DeepSeek V4 (default main Agent):

```powershell
Copy-Item .env.example .env
# Edit only the ignored .env file and set DEEPSEEK_API_KEY there.
npm run dev:api
```

`npm run dev:api`, `npm run start:api`, and `npm run dev:cli` load `.env` when it exists. Keep `AGENT_MODEL=deepseek-v4-flash` for the faster default, or use the Pi 0.84.1-supported `deepseek-v4-pro`. Never commit `.env`.

Volcengine Ark:

```powershell
$env:AGENT_PROVIDER = "volcengine"
$env:AGENT_MODEL = "doubao-seed-2-1-turbo-260628"
$env:ARK_API_KEY = "<set in your shell or secret manager>"
npm run dev:cli
```

Keys are resolved server-side and never returned by `/v1/meta` or written to session files. Model selections are configuration defaults only until P0-02 receives joint approval.

## Architecture

```text
Product UI
    -> API and event boundary
    -> LocalAgentRuntime (persisted workId binding)
    -> Pi Agent Core
       -> unbound session: tools=[]
       -> work-bound session: policy-gated vehicle and strategy tools
```

Read [docs/architecture.md](docs/architecture.md) for component responsibilities, [docs/tracks/agent-dialog-track-todo.md](docs/tracks/agent-dialog-track-todo.md) for the Agent dialog development track, and [docs/decisions/open-decisions.md](docs/decisions/open-decisions.md) for decisions that need business or infrastructure input before external model integration.

## Security model

- The production agent receives no generic shell or filesystem tools.
- Unbound framework sessions start with no tools; API sessions bound to a valid work receive only the five allowlisted vehicle and strategy tools.
- Actor and project identity come from server-side session scope.
- All tool calls are checked against workflow state and tool risk.
- Secrets stay in the server-side deployment secret store.
- Human approval is a backend event, not a model-callable tool.
