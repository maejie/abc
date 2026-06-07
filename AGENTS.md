# Repository Guidelines

## Project Structure & Module Organization

This repository is a TypeScript monorepo for a budget planning MVP. Keep changes scoped to the relevant workspace:

- `apps/backend/` contains the framework-free Node HTTP JSON API.
- `apps/frontend/` contains the React + Vite spreadsheet UI.
- `packages/domain/` contains shared types, seed data, formula evaluation, and recalculation logic.

Do not move calculation logic into React components or HTTP handlers. The domain package is the boundary that should remain easy to replace from another backend implementation.

## Build, Test, and Development Commands

Use pnpm from the repository root:

- `pnpm install`: install workspace dependencies.
- `pnpm dev`: run backend on `localhost:4000` and frontend on `localhost:5173`.
- `pnpm typecheck`: typecheck all workspaces.
- `pnpm build`: build the domain, backend, and frontend.

Use `pnpm --filter backend dev` or `pnpm --filter frontend dev` to run one app at a time.

## Coding Style & Naming Conventions

Use TypeScript with strict types. Keep interfaces and API request/response shapes explicit. Use two-space indentation, semicolons, and descriptive camelCase names for variables/functions. React components should be PascalCase.

Avoid `eval` and backend web frameworks. The backend should stay close to Node’s built-in HTTP APIs.

## Testing Guidelines

No test runner is configured yet. Until one is added, run `pnpm typecheck` and `pnpm build` before opening a pull request.

When tests are introduced, prioritize `packages/domain/` coverage for formula parsing, circular dependency detection, and recalculation propagation. Name tests after behavior, for example `recalculates downstream series`.

## Commit & Pull Request Guidelines

This checkout does not include Git history, so no existing commit convention can be inferred. Use concise, imperative commit subjects such as `Add budget grid` or `Fix formula propagation`.

Pull requests should include a short summary, testing performed, and relevant issue links. Include screenshots or recordings for frontend changes. Call out API shape changes explicitly.

## Security & Configuration Tips

Do not commit secrets, tokens, or machine-specific configuration. The backend is in-memory only; data resets on process restart.
