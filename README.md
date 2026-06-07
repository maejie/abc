# Budget Planner MVP

A TypeScript prototype for a monthly budget planning application. The backend is intentionally small and uses Node.js built-in HTTP only, with all domain and calculation logic kept outside the server layer so it can be replaced later.

## Project Structure

```text
apps/backend/       Node HTTP JSON API
apps/frontend/      React + Vite + ReactGrid UI
packages/domain/    Budget model, seed data, formula evaluation, recalculation
```

The domain package owns the core concepts: `Budget`, `Scenario`, `Series`, `Value`, and `FormulaBinding`. React components never evaluate formulas.

## Setup

Install dependencies:

```bash
pnpm install
```

Run backend and frontend together:

```bash
pnpm dev
```

Environment variables are loaded from a root `.env` file. Start from one of the examples:

```bash
cp .env.dev.example .env
```

To use local passwordless user-name login during development:

```bash
ALLOW_PASSWORDLESS_AUTH=true VITE_ALLOW_PASSWORDLESS_AUTH=true pnpm dev
```

Default URLs:

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:4000`

Set `APP_BASE_PATH` and `VITE_APP_BASE_PATH` to serve the app under a subpath such as `/abc`. With `VITE_APP_BASE_PATH=/abc`, the frontend root is `http://localhost:5173/abc/`, and scenario pages use URLs such as `/abc/budgets/budget-mvp/scenarios/scenario-base`.

From the root page, users can create a new budget or create a new scenario by copying an existing scenario in the same budget. New budgets start with a `Base Case` scenario containing only `Income Subtotal`, `Expense Subtotal`, and `Total`.

Scenario pages subscribe to Server-Sent Events at `${APP_BASE_PATH}/api/budgets/:budgetId/scenarios/:scenarioId/events`, so edits from another browser or API client update open views automatically.

Local development can use a passwordless user-name auth mode. It is disabled by default and must be enabled with `ALLOW_PASSWORDLESS_AUTH=true` for the backend and `VITE_ALLOW_PASSWORDLESS_AUTH=true` for the frontend. Do not enable this mode for public production traffic. Budget owners can share budgets with other users from the root page.

The backend also accepts Google OAuth access tokens with `Authorization: Bearer <token>`. Tokens are validated against Google's userinfo endpoint and mapped to the verified email address.

Run individual apps:

```bash
pnpm --filter backend dev
pnpm --filter frontend dev
```

Typecheck all packages:

```bash
pnpm typecheck
```

Build all packages:

```bash
pnpm build
```

## API

API routes live under `APP_BASE_PATH`. With `APP_BASE_PATH=/abc`, use `/abc/api/...`.

- `GET /api/state` returns the seeded budget, scenario, periods, series, values, and formula bindings.
- `PUT /api/values` updates one editable monthly value and recalculates affected downstream series for the same period.
- `PUT /api/series/:seriesId/formula` updates one series formula and bindings, checks circular dependencies, and recalculates affected values.
- `POST /api/recalculate` recalculates the full scenario for maintenance/debugging.

## Remote MCP

The backend exposes a prototype remote MCP endpoint at `POST ${APP_BASE_PATH}/mcp`. It supports JSON-RPC MCP methods `initialize`, `tools/list`, and `tools/call`.

Authentication options:

- Optional passwordless mode: send `X-Dev-User: alice` only when `ALLOW_PASSWORDLESS_AUTH=true`.
- Remote Google login: send `Authorization: Bearer <Google OAuth access token>`.

OAuth protected resource metadata is available at:

```text
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-protected-resource/mcp
```

When `APP_BASE_PATH=/abc`, these are served as `/abc/.well-known/oauth-protected-resource` and `/abc/.well-known/oauth-protected-resource/mcp`.

Available MCP tools:

- `list_budgets`
- `get_scenario_state`
- `update_value`
- `create_budget`
- `create_scenario`
- `share_budget`

MCP updates reuse the same domain logic and publish the same SSE scenario updates as the browser UI.

## Production Deployment

Use Google sign-in for production and leave passwordless auth off:

```bash
cp .env.prod.example .env
pnpm --filter backend build
pnpm --filter frontend build
pnpm --filter backend start
```

The backend can serve HTTPS directly when certificate files are already available:

```bash
HTTPS=true TLS_CERT_FILE=/etc/letsencrypt/live/example.com/fullchain.pem TLS_KEY_FILE=/etc/letsencrypt/live/example.com/privkey.pem PORT=443 pnpm --filter backend start
```

For automatic Let's Encrypt issuance and rotation, use Caddy in front of the Node backend:

```bash
BUDGET_DOMAIN=example.com BUDGET_BASE_PATH=/abc ACME_EMAIL=admin@example.com BACKEND_UPSTREAM=localhost:4000 FRONTEND_DIST=/srv/budget-frontend caddy run --config deploy/Caddyfile
```

Set `BUDGET_BASE_PATH` to the same value as `APP_BASE_PATH`; use an empty value for domain-root deployment or `/abc` for subpath deployment. Caddy serves the built frontend over HTTPS, renews certificates automatically, and proxies `${BUDGET_BASE_PATH}/api/*`, `${BUDGET_BASE_PATH}/mcp`, and OAuth metadata requests to the backend.

## Seed Scenario

The in-memory store starts with `MVP Budget`, currency `JPY`, from `2026-01` to `2026-06`, and a `Base Case` scenario.

Seeded series include Revenue, Users, Unit Price, Engineer Cost, Headcount, Unit Cost, Cloud Cost, Income Subtotal, Expense Subtotal, and Total. Revenue, Engineer Cost, subtotals, and Total are calculated automatically from formula bindings.

Formulas support arithmetic, variables, parentheses, and aggregate expressions such as `Sum(Type=Income)` and `Sum(Type=Expense)`.

The grid display order is derived from domain meaning and formula bindings: income rows and their subtotal, expense rows and their subtotal, Total, other calculated rows, then unreferenced parameters. Parameters referenced by a formula are shown under the referencing series in formula variable order.

## Notes

No database, ORM, authentication, or backend web framework is used. All data resets when the backend process restarts.
