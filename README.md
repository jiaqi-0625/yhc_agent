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

## Install

```powershell
npm install --ignore-scripts
```

## Validate

```powershell
npm run check
```

The check command runs strict TypeScript validation, automated tests, and a local credential-pattern scan.

Production dependency audit:

```powershell
npm run audit:prod
```

## Run locally without a model key

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

The page creates and restores a local session and also runs the golden-sample business flow: create a vehicle snapshot, generate a strategy, edit or lock items, regenerate unlocked items, submit for approval, and make an explicit human decision. The work list supports creating and switching among multiple works, restores the selected work after refresh, and can create a fresh work from an approved vehicle snapshot. The main Agent defaults to DeepSeek; without a server-side key the UI remains available for diagnostics while model calls fail closed and never fall back to Mock.

Default endpoints:

- `GET http://127.0.0.1:3100/health`
- `GET http://127.0.0.1:3100/v1/meta`
- `POST http://127.0.0.1:3100/v1/sessions`
- `POST http://127.0.0.1:3100/v1/sessions/{id}/messages`
- `GET http://127.0.0.1:3100/v1/sessions/{id}/transcript`
- `POST http://127.0.0.1:3100/v1/sessions/{id}/reset`
- `POST http://127.0.0.1:3100/v1/sessions/{id}/abort`
- `DELETE http://127.0.0.1:3100/v1/sessions/{id}`
- `GET/POST http://127.0.0.1:3100/v1/works`
- `GET http://127.0.0.1:3100/v1/works/{id}`
- `POST http://127.0.0.1:3100/v1/works/{id}/strategy/generate`
- `PATCH http://127.0.0.1:3100/v1/works/{id}/strategy`
- `POST http://127.0.0.1:3100/v1/works/{id}/strategy/approval-request`
- `POST http://127.0.0.1:3100/v1/works/{id}/strategy/decision`
- `POST http://127.0.0.1:3100/v1/works/{id}/copy`

Set `PORT` to use a different port.

Example:

```powershell
$session = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3100/v1/sessions -ContentType application/json -Body '{}'
$id = $session.session.id
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3100/v1/sessions/$id/messages" -ContentType application/json -Body '{"message":"你好"}'
```

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
