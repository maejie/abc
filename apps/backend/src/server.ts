import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { resolve } from "node:path";
import {
  createSeries,
  bindingsFromFormula,
  createSeedStates,
  deleteSeries,
  recalculateScenario,
  updateSeriesDetails,
  updateManualValue,
  updateSeriesFormula,
  type CreateSeriesRequest,
  type AppState,
  type Budget,
  type BudgetShare,
  type CreateBudgetRequest,
  type CreateScenarioRequest,
  type User,
  type Series,
  type ShareBudgetRequest,
  type UpdateFormulaRequest,
  type UpdateSeriesRequest,
  type UpdateValueRequest,
  type Value,
} from "@budget/domain";

loadDotEnv();

const port = Number(process.env.PORT ?? 4000);
const useHttps = process.env.HTTPS === "true";
const tlsCertFile = process.env.TLS_CERT_FILE;
const tlsKeyFile = process.env.TLS_KEY_FILE;
const allowPasswordlessAuth = process.env.ALLOW_PASSWORDLESS_AUTH === "true";
const appBasePath = normalizeBasePath(process.env.APP_BASE_PATH ?? "/");
const states = createSeedStates();
const subscribers = new Map<string, Set<ServerResponse>>();
const users = new Map<string, User>([
  ["alice", { id: "alice", name: "alice", authProvider: "dev" }],
  ["bob", { id: "bob", name: "bob", authProvider: "dev" }],
]);
const budgetShares: BudgetShare[] = [];
const googleTokenCache = new Map<string, { user: User; cachedAt: number }>();
const googleTokenCacheTtlMs = 5 * 60 * 1000;
const googleUserInfoUrl = "https://www.googleapis.com/oauth2/v3/userinfo";
const mcpProtocolVersion = "2025-06-18";

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc?: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

const requestHandler = async (request: IncomingMessage, response: ServerResponse) => {
  try {
    setCorsHeaders(response);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
      return;
    }

    const rawUrl = new URL(request.url ?? "/", requestOrigin(request));
    const routePath = stripBasePath(rawUrl.pathname);
    if (!routePath) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    const url = new URL(rawUrl);
    url.pathname = routePath;
    if (request.method === "GET" && isProtectedResourceMetadataPath(url.pathname)) {
      sendJson(response, 200, protectedResourceMetadata(url.origin));
      return;
    }

    if (request.method === "POST" && url.pathname === "/mcp") {
      await handleMcpRequest(request, response, url);
      return;
    }

    const currentUser = await authenticateRequest(request, url);

    if (request.method === "GET" && url.pathname === "/api/budgets") {
      sendJson(response, 200, budgetTree(currentUser.id));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/budgets") {
      const body = await readJson<CreateBudgetRequest>(request);
      validateCreateBudget(body);
      const state = createEmptyBudgetState(body, currentUser.id);
      states.push(state);
      sendJson(response, 201, { state, tree: budgetTree(currentUser.id) });
      return;
    }

    const shareMatch = /^\/api\/budgets\/([^/]+)\/shares$/.exec(url.pathname);
    if (request.method === "POST" && shareMatch) {
      const budgetId = decodeURIComponent(shareMatch[1]);
      const budget = findBudgetForOwner(budgetId, currentUser.id);
      const body = await readJson<ShareBudgetRequest>(request);
      if (typeof body.userName !== "string" || !body.userName.trim()) throw httpError(400, "User name is required");
      const user = getOrCreateUser(body.userName);
      if (user.id === budget.ownerUserId) throw httpError(400, "Budget owner already has access");
      if (!budgetShares.some((share) => share.budgetId === budget.id && share.userId === user.id)) {
        budgetShares.push({ budgetId: budget.id, userId: user.id });
      }
      sendJson(response, 200, { tree: budgetTree(currentUser.id) });
      return;
    }

    const scenarioCollectionMatch = /^\/api\/budgets\/([^/]+)\/scenarios$/.exec(url.pathname);
    if (request.method === "POST" && scenarioCollectionMatch) {
      const budgetId = decodeURIComponent(scenarioCollectionMatch[1]);
      const body = await readJson<CreateScenarioRequest>(request);
      validateCreateScenario(body);
      if (body.sourceBudgetId !== budgetId) {
        throw httpError(400, "Source scenario must belong to the selected budget");
      }
      const source = findAccessibleState(body.sourceBudgetId, body.sourceScenarioId, currentUser.id);
      const state = cloneScenarioState(source, body.name);
      states.push(state);
      sendJson(response, 201, { state, tree: budgetTree(currentUser.id) });
      return;
    }

    const stateMatch = /^\/api\/budgets\/([^/]+)\/scenarios\/([^/]+)\/state$/.exec(url.pathname);
    if (request.method === "GET" && stateMatch) {
      sendJson(response, 200, findAccessibleState(decodeURIComponent(stateMatch[1]), decodeURIComponent(stateMatch[2]), currentUser.id));
      return;
    }

    const eventsMatch = /^\/api\/budgets\/([^/]+)\/scenarios\/([^/]+)\/events$/.exec(url.pathname);
    if (request.method === "GET" && eventsMatch) {
      const state = findAccessibleState(decodeURIComponent(eventsMatch[1]), decodeURIComponent(eventsMatch[2]), currentUser.id);
      subscribeToScenario(request, response, state);
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, states[0]);
      return;
    }

    const valuesMatch = /^\/api\/budgets\/([^/]+)\/scenarios\/([^/]+)\/values$/.exec(url.pathname);
    if (request.method === "PUT" && (url.pathname === "/api/values" || valuesMatch)) {
      const state = valuesMatch ? findAccessibleState(decodeURIComponent(valuesMatch[1]), decodeURIComponent(valuesMatch[2]), currentUser.id) : states[0];
      const body = await readJson<UpdateValueRequest>(request);
      validateValueUpdate(body);
      const targetSeries = state.series.find((series) => series.id === body.seriesId);
      if (!targetSeries) throw httpError(404, "Series not found");
      if (targetSeries.formula || targetSeries.type === "calculated") {
        throw httpError(400, "Formula-based series cannot be edited directly");
      }
      const updatedValues = updateManualValue(state, body.seriesId, body.period, body.value);
      sendJson(response, 200, { updatedValues });
      publishScenarioState(state);
      return;
    }

    const scopedSeriesCollectionMatch = /^\/api\/budgets\/([^/]+)\/scenarios\/([^/]+)\/series$/.exec(url.pathname);
    if (request.method === "POST" && (url.pathname === "/api/series" || scopedSeriesCollectionMatch)) {
      const state = scopedSeriesCollectionMatch
        ? findAccessibleState(decodeURIComponent(scopedSeriesCollectionMatch[1]), decodeURIComponent(scopedSeriesCollectionMatch[2]), currentUser.id)
        : states[0];
      const body = await readJson<CreateSeriesRequest>(request);
      validateSeriesMutation(body, false);
      const { updatedValues } = createSeries(state, body);
      sendJson(response, 201, { state, updatedValues });
      publishScenarioState(state);
      return;
    }

    const scopedSeriesMatch = /^\/api\/budgets\/([^/]+)\/scenarios\/([^/]+)\/series\/([^/]+)$/.exec(url.pathname);
    const seriesMatch = /^\/api\/series\/([^/]+)$/.exec(url.pathname);
    const activeSeriesMatch = scopedSeriesMatch ?? seriesMatch;
    if (request.method === "PUT" && seriesMatch) {
      const state = states[0];
      const body = await readJson<UpdateSeriesRequest>(request);
      validateSeriesMutation(body, true);
      const seriesId = decodeURIComponent(seriesMatch[1]);
      const { updatedValues } = updateSeriesDetails(state, seriesId, body);
      sendJson(response, 200, { state, updatedValues });
      publishScenarioState(state);
      return;
    }

    if (request.method === "PUT" && scopedSeriesMatch) {
      const state = findAccessibleState(decodeURIComponent(scopedSeriesMatch[1]), decodeURIComponent(scopedSeriesMatch[2]), currentUser.id);
      const body = await readJson<UpdateSeriesRequest>(request);
      validateSeriesMutation(body, true);
      const seriesId = decodeURIComponent(scopedSeriesMatch[3]);
      const { updatedValues } = updateSeriesDetails(state, seriesId, body);
      sendJson(response, 200, { state, updatedValues });
      publishScenarioState(state);
      return;
    }

    if (request.method === "DELETE" && activeSeriesMatch) {
      const state = scopedSeriesMatch
        ? findAccessibleState(decodeURIComponent(scopedSeriesMatch[1]), decodeURIComponent(scopedSeriesMatch[2]), currentUser.id)
        : states[0];
      const seriesId = decodeURIComponent(scopedSeriesMatch ? scopedSeriesMatch[3] : seriesMatch![1]);
      const { updatedValues } = deleteSeries(state, seriesId);
      sendJson(response, 200, { state, updatedValues });
      publishScenarioState(state);
      return;
    }

    const scopedFormulaMatch = /^\/api\/budgets\/([^/]+)\/scenarios\/([^/]+)\/series\/([^/]+)\/formula$/.exec(url.pathname);
    const formulaMatch = /^\/api\/series\/([^/]+)\/formula$/.exec(url.pathname);
    const activeFormulaMatch = scopedFormulaMatch ?? formulaMatch;
    if (request.method === "PUT" && activeFormulaMatch) {
      const state = scopedFormulaMatch
        ? findAccessibleState(decodeURIComponent(scopedFormulaMatch[1]), decodeURIComponent(scopedFormulaMatch[2]), currentUser.id)
        : states[0];
      const body = await readJson<UpdateFormulaRequest>(request);
      if (typeof body.formula !== "string" || !Array.isArray(body.bindings)) {
        throw httpError(400, "Invalid formula update request");
      }
      const seriesId = decodeURIComponent(scopedFormulaMatch ? scopedFormulaMatch[3] : formulaMatch![1]);
      const updatedValues = updateSeriesFormula(state, seriesId, body.formula, bindingsFromFormula(state, seriesId, body.formula));
      const series = state.series.find((item) => item.id === seriesId);
      const formulaBindings = state.formulaBindings.filter((binding) => binding.targetSeriesId === seriesId);
      sendJson(response, 200, { series, formulaBindings, updatedValues });
      publishScenarioState(state);
      return;
    }

    const recalculateMatch = /^\/api\/budgets\/([^/]+)\/scenarios\/([^/]+)\/recalculate$/.exec(url.pathname);
    if (request.method === "POST" && (url.pathname === "/api/recalculate" || recalculateMatch)) {
      const state = recalculateMatch ? findAccessibleState(decodeURIComponent(recalculateMatch[1]), decodeURIComponent(recalculateMatch[2]), currentUser.id) : states[0];
      const updatedValues = recalculateScenario(state);
      sendJson(response, 200, { updatedValues });
      publishScenarioState(state);
      return;
    }

    sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    const message = error instanceof Error ? error.message : "Unexpected server error";
    sendJson(response, statusCode, { error: message });
  }
};

function isProtectedResourceMetadataPath(pathname: string): boolean {
  return pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp";
}

function stripBasePath(pathname: string): string | null {
  if (appBasePath === "/") return pathname;
  if (pathname === appBasePath) return "/";
  if (!pathname.startsWith(`${appBasePath}/`)) return null;
  return pathname.slice(appBasePath.length) || "/";
}

function requestOrigin(request: IncomingMessage): string {
  const forwardedProto = headerValue(request.headers["x-forwarded-proto"])?.split(",")[0]?.trim();
  const forwardedHost = headerValue(request.headers["x-forwarded-host"])?.split(",")[0]?.trim();
  const host = forwardedHost || headerValue(request.headers.host) || "localhost";
  const proto = forwardedProto || ((request.socket as { encrypted?: boolean }).encrypted ? "https" : "http");
  return `${proto}://${host}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function externalPath(pathname: string): string {
  if (appBasePath === "/") return pathname;
  return `${appBasePath}${pathname}`;
}

function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}${externalPath("/mcp")}`,
    authorization_servers: ["https://accounts.google.com"],
    scopes_supported: ["openid", "email", "profile"],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}${externalPath("/mcp")}`,
  };
}

async function handleMcpRequest(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
  response.setHeader("MCP-Protocol-Version", mcpProtocolVersion);
  let currentUser: User;
  try {
    currentUser = await authenticateRequest(request, url);
  } catch (error) {
    response.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${url.origin}${externalPath("/.well-known/oauth-protected-resource")}"`,
    );
    throw error;
  }

  const body = await readJson<JsonRpcRequest | JsonRpcRequest[]>(request);
  const requests = Array.isArray(body) ? body : [body];
  const results = [];
  for (const rpcRequest of requests) {
    const result = await handleMcpRpc(rpcRequest, currentUser);
    if (result) results.push(result);
  }

  if (Array.isArray(body)) {
    if (results.length === 0) {
      response.writeHead(202);
      response.end();
      return;
    }
    sendJson(response, 200, results);
    return;
  }

  if (results.length === 0) {
    response.writeHead(202);
    response.end();
    return;
  }
  sendJson(response, 200, results[0]);
}

async function handleMcpRpc(request: JsonRpcRequest, currentUser: User): Promise<unknown | null> {
  if (!request || typeof request.method !== "string") {
    return jsonRpcError(null, -32600, "Invalid JSON-RPC request");
  }

  try {
    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        protocolVersion: mcpProtocolVersion,
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "budget-planner",
          version: "0.1.0",
        },
      });
    }

    if (request.method === "notifications/initialized") {
      return null;
    }

    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, { tools: mcpTools() });
    }

    if (request.method === "tools/call") {
      const params = objectParam(request.params);
      const name = stringField(params, "name");
      const args = objectParam(params.arguments ?? {});
      const toolResult = await callMcpTool(name, args, currentUser);
      return jsonRpcResult(request.id, {
        content: [{ type: "text", text: JSON.stringify(toolResult, null, 2) }],
      });
    }

    return jsonRpcError(request.id, -32601, `Unknown method: ${request.method}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected MCP error";
    return jsonRpcError(request.id, -32000, message);
  }
}

function mcpTools() {
  return [
    {
      name: "list_budgets",
      description: "List budgets and scenarios accessible to the authenticated user.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "get_scenario_state",
      description: "Get the full state for one budget scenario.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: { type: "string" },
          scenarioId: { type: "string" },
        },
        required: ["budgetId", "scenarioId"],
        additionalProperties: false,
      },
    },
    {
      name: "update_value",
      description: "Update one or more editable monthly values and recalculate affected series. Pass either seriesId/period/value for one cell, or updates for bulk edits across multiple periods and series.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: { type: "string" },
          scenarioId: { type: "string" },
          seriesId: { type: "string" },
          period: { type: "string" },
          value: { type: "number" },
          updates: {
            type: "array",
            description: "Bulk value updates. Use this for multiple months and/or multiple series in one MCP call.",
            items: {
              type: "object",
              properties: {
                seriesId: { type: "string" },
                period: { type: "string" },
                value: { type: "number" },
              },
              required: ["seriesId", "period", "value"],
              additionalProperties: false,
            },
          },
        },
        required: ["budgetId", "scenarioId"],
        additionalProperties: false,
      },
    },
    {
      name: "create_series",
      description: [
        "Create one series in a scenario and recalculate formulas.",
        "Important modeling guidance: when adding income or expense, avoid creating a single manual amount if a unit structure can be inferred.",
        "Prefer adding parameter series such as quantity, users, headcount, unitPrice, or unitCost, then create the income/expense series with a formula like users * unitPrice or headcount * unitCost.",
        "Only create a manual income/expense amount with no formula when no plausible parameter structure is available.",
      ].join(" "),
      inputSchema: {
        type: "object",
        properties: {
          budgetId: { type: "string" },
          scenarioId: { type: "string" },
          key: { type: "string", description: "Unique formula-safe key, e.g. marketingCost or unitPrice." },
          name: { type: "string" },
          type: { type: "string", enum: ["income", "expense", "parameter", "calculated"] },
          formula: { type: "string", description: "Optional series-level formula. Do not use eval syntax; use series keys and arithmetic." },
          unit: { type: "string", description: "Optional display unit, e.g. JPY/user, people, users." },
        },
        required: ["budgetId", "scenarioId", "key", "name", "type"],
        additionalProperties: false,
      },
    },
    {
      name: "update_series",
      description: "Update an existing series definition, including key, name, type, formula, and unit. Recalculates affected values and publishes live updates.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: { type: "string" },
          scenarioId: { type: "string" },
          seriesId: { type: "string" },
          key: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["income", "expense", "parameter", "calculated"] },
          formula: { type: "string" },
          unit: { type: "string" },
        },
        required: ["budgetId", "scenarioId", "seriesId"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_series",
      description: "Delete a series from a scenario, remove its values and formula bindings, then recalculate affected downstream values.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: { type: "string" },
          scenarioId: { type: "string" },
          seriesId: { type: "string" },
        },
        required: ["budgetId", "scenarioId", "seriesId"],
        additionalProperties: false,
      },
    },
    {
      name: "create_budget",
      description: "Create a budget owned by the authenticated user with a default Base Case scenario.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          currency: { type: "string" },
          startPeriod: { type: "string" },
          endPeriod: { type: "string" },
        },
        required: ["name", "currency", "startPeriod", "endPeriod"],
        additionalProperties: false,
      },
    },
    {
      name: "create_scenario",
      description: "Create a new scenario by copying an existing scenario in the same budget.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: { type: "string" },
          name: { type: "string" },
          sourceScenarioId: { type: "string" },
        },
        required: ["budgetId", "name", "sourceScenarioId"],
        additionalProperties: false,
      },
    },
    {
      name: "share_budget",
      description: "Share an owned budget with another user.",
      inputSchema: {
        type: "object",
        properties: {
          budgetId: { type: "string" },
          userName: { type: "string" },
        },
        required: ["budgetId", "userName"],
        additionalProperties: false,
      },
    },
  ];
}

async function callMcpTool(name: string, args: Record<string, unknown>, currentUser: User): Promise<unknown> {
  if (name === "list_budgets") {
    return budgetTree(currentUser.id);
  }

  if (name === "get_scenario_state") {
    return findAccessibleState(stringField(args, "budgetId"), stringField(args, "scenarioId"), currentUser.id);
  }

  if (name === "update_value") {
    const state = findAccessibleState(stringField(args, "budgetId"), stringField(args, "scenarioId"), currentUser.id);
    const updates = valueUpdateRequests(args);
    const changed = new Map<string, Value>();
    for (const body of updates) {
      validateValueUpdate(body);
      const targetSeries = state.series.find((series) => series.id === body.seriesId);
      if (!targetSeries) throw httpError(404, `Series not found: ${body.seriesId}`);
      if (targetSeries.formula || targetSeries.type === "calculated") {
        throw httpError(400, `Formula-based series cannot be edited directly: ${targetSeries.name}`);
      }
      for (const value of updateManualValue(state, body.seriesId, body.period, body.value)) {
        changed.set(`${value.seriesId}:${value.period}`, value);
      }
    }
    publishScenarioState(state);
    return { updatedValues: [...changed.values()] };
  }

  if (name === "create_series") {
    const state = findAccessibleState(stringField(args, "budgetId"), stringField(args, "scenarioId"), currentUser.id);
    const body: CreateSeriesRequest = {
      key: stringField(args, "key"),
      name: stringField(args, "name"),
      type: seriesTypeField(args, "type"),
      formula: optionalStringField(args, "formula"),
      unit: optionalStringField(args, "unit"),
    };
    validateSeriesMutation(body, false);
    const { series, updatedValues } = createSeries(state, body);
    publishScenarioState(state);
    return { series, state, updatedValues };
  }

  if (name === "update_series") {
    const state = findAccessibleState(stringField(args, "budgetId"), stringField(args, "scenarioId"), currentUser.id);
    const body: UpdateSeriesRequest = {};
    const key = optionalStringField(args, "key");
    const seriesName = optionalStringField(args, "name");
    const type = optionalSeriesTypeField(args, "type");
    const formula = optionalStringField(args, "formula");
    const unit = optionalStringField(args, "unit");
    if (key !== undefined) body.key = key;
    if (seriesName !== undefined) body.name = seriesName;
    if (type !== undefined) body.type = type;
    if (formula !== undefined) body.formula = formula;
    if (unit !== undefined) body.unit = unit;
    validateSeriesMutation(body, true);
    const { series, updatedValues } = updateSeriesDetails(state, stringField(args, "seriesId"), body);
    publishScenarioState(state);
    return { series, state, updatedValues };
  }

  if (name === "delete_series") {
    const state = findAccessibleState(stringField(args, "budgetId"), stringField(args, "scenarioId"), currentUser.id);
    const updatedValues = deleteSeries(state, stringField(args, "seriesId")).updatedValues;
    publishScenarioState(state);
    return { state, updatedValues };
  }

  if (name === "create_budget") {
    const body: CreateBudgetRequest = {
      name: stringField(args, "name"),
      currency: stringField(args, "currency"),
      startPeriod: stringField(args, "startPeriod"),
      endPeriod: stringField(args, "endPeriod"),
    };
    validateCreateBudget(body);
    const state = createEmptyBudgetState(body, currentUser.id);
    states.push(state);
    return { state, tree: budgetTree(currentUser.id) };
  }

  if (name === "create_scenario") {
    const budgetId = stringField(args, "budgetId");
    const body: CreateScenarioRequest = {
      name: stringField(args, "name"),
      sourceBudgetId: budgetId,
      sourceScenarioId: stringField(args, "sourceScenarioId"),
    };
    validateCreateScenario(body);
    const source = findAccessibleState(body.sourceBudgetId, body.sourceScenarioId, currentUser.id);
    const state = cloneScenarioState(source, body.name);
    states.push(state);
    return { state, tree: budgetTree(currentUser.id) };
  }

  if (name === "share_budget") {
    const budget = findBudgetForOwner(stringField(args, "budgetId"), currentUser.id);
    const userName = stringField(args, "userName");
    const user = getOrCreateUser(userName);
    if (user.id === budget.ownerUserId) throw httpError(400, "Budget owner already has access");
    if (!budgetShares.some((share) => share.budgetId === budget.id && share.userId === user.id)) {
      budgetShares.push({ budgetId: budget.id, userId: user.id });
    }
    return { tree: budgetTree(currentUser.id) };
  }

  throw httpError(404, `Unknown MCP tool: ${name}`);
}

function jsonRpcResult(id: JsonRpcId | undefined, result: unknown) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    result,
  };
}

function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
    },
  };
}

function objectParam(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw httpError(400, "Expected object parameters");
  }
  return value as Record<string, unknown>;
}

function stringField(input: Record<string, unknown>, field: string): string {
  const value = input[field];
  if (typeof value !== "string" || !value.trim()) {
    throw httpError(400, `${field} is required`);
  }
  return value;
}

function optionalStringField(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw httpError(400, `${field} must be a string`);
  }
  return value;
}

function seriesTypeField(input: Record<string, unknown>, field: string): Series["type"] {
  const value = stringField(input, field);
  if (!isSeriesType(value)) {
    throw httpError(400, `${field} must be income, expense, parameter, or calculated`);
  }
  return value;
}

function optionalSeriesTypeField(input: Record<string, unknown>, field: string): Series["type"] | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !isSeriesType(value)) {
    throw httpError(400, `${field} must be income, expense, parameter, or calculated`);
  }
  return value;
}

function isSeriesType(value: string): value is Series["type"] {
  return ["income", "expense", "parameter", "calculated"].includes(value);
}

function numberField(input: Record<string, unknown>, field: string): number {
  const value = input[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw httpError(400, `${field} must be a finite number`);
  }
  return value;
}

function valueUpdateRequests(input: Record<string, unknown>): UpdateValueRequest[] {
  const rawUpdates = input.updates;
  if (rawUpdates !== undefined) {
    if (!Array.isArray(rawUpdates) || rawUpdates.length === 0) {
      throw httpError(400, "updates must be a non-empty array");
    }
    return rawUpdates.map((item) => {
      const update = objectParam(item);
      return {
        seriesId: stringField(update, "seriesId"),
        period: stringField(update, "period"),
        value: numberField(update, "value"),
      };
    });
  }

  if (input.seriesId === undefined || input.period === undefined || input.value === undefined) {
    throw httpError(400, "Provide either updates or seriesId, period, and value");
  }
  return [{
    seriesId: stringField(input, "seriesId"),
    period: stringField(input, "period"),
    value: numberField(input, "value"),
  }];
}

function findState(budgetId: string, scenarioId: string) {
  const state = states.find((item) => item.budget.id === budgetId && item.scenario.id === scenarioId);
  if (!state) throw httpError(404, "Scenario not found");
  return state;
}

async function authenticateRequest(request: IncomingMessage, url: URL): Promise<User> {
  const googleAccessToken = readBearerToken(request) ?? url.searchParams.get("accessToken");
  if (googleAccessToken) {
    return authenticateGoogleAccessToken(googleAccessToken);
  }
  return authenticateDevUser(request, url);
}

function authenticateDevUser(request: IncomingMessage, url: URL): User {
  if (!allowPasswordlessAuth) {
    throw httpError(401, "Passwordless user-name authentication is disabled");
  }
  const rawUser = request.headers["x-dev-user"] ?? url.searchParams.get("devUser");
  const userName = Array.isArray(rawUser) ? rawUser[0] : rawUser;
  if (!userName || !userName.trim()) {
    throw httpError(401, "Authentication requires Authorization: Bearer <Google access token> or X-Dev-User");
  }
  return getOrCreateUser(userName);
}

function readBearerToken(request: IncomingMessage): string | null {
  const rawHeader = request.headers.authorization;
  const authorization = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/.exec(authorization);
  if (!match?.[1].trim()) {
    throw httpError(401, "Authorization header must use the Bearer scheme");
  }
  return match[1].trim();
}

async function authenticateGoogleAccessToken(accessToken: string): Promise<User> {
  const cached = googleTokenCache.get(accessToken);
  if (cached && cached.cachedAt + googleTokenCacheTtlMs > Date.now()) {
    return cached.user;
  }

  let result: Response;
  try {
    result = await fetch(googleUserInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });
  } catch {
    throw httpError(502, "Failed to reach Google for token validation");
  }

  if (!result.ok) {
    throw httpError(401, "Google access token is invalid or expired");
  }

  const payload = await result.json() as Partial<{
    sub: string;
    email: string;
    email_verified: boolean;
    name: string;
  }>;
  if (!payload.email || payload.email_verified !== true) {
    throw httpError(401, "Google sign-in requires a verified email address");
  }

  const normalizedEmail = payload.email.trim().toLowerCase();
  const user = upsertUser({
    id: normalizedEmail,
    name: payload.name?.trim() || normalizedEmail,
    authProvider: "google",
    email: normalizedEmail,
  });
  googleTokenCache.set(accessToken, { user, cachedAt: Date.now() });
  return user;
}

function getOrCreateUser(userName: string): User {
  return upsertUser({
    id: userName.trim().toLowerCase(),
    name: userName.trim(),
    authProvider: "dev",
  });
}

function upsertUser(user: User): User {
  const existing = users.get(user.id);
  if (!existing) {
    users.set(user.id, user);
    return user;
  }
  const nextUser = {
    ...existing,
    ...user,
  };
  users.set(nextUser.id, nextUser);
  return nextUser;
}

function findAccessibleState(budgetId: string, scenarioId: string, userId: string) {
  const state = findState(budgetId, scenarioId);
  if (!canAccessBudget(state.budget.id, userId)) throw httpError(403, "Budget access denied");
  return state;
}

function findBudgetForOwner(budgetId: string, userId: string): Budget {
  const budget = states.find((state) => state.budget.id === budgetId)?.budget;
  if (!budget) throw httpError(404, "Budget not found");
  if (budget.ownerUserId !== userId) throw httpError(403, "Only the owner can share this budget");
  return budget;
}

function canAccessBudget(budgetId: string, userId: string): boolean {
  const budget = states.find((state) => state.budget.id === budgetId)?.budget;
  if (!budget) return false;
  return budget.ownerUserId === userId || budgetShares.some((share) => share.budgetId === budgetId && share.userId === userId);
}

function scenarioChannelKey(state: AppState): string {
  return `${state.budget.id}:${state.scenario.id}`;
}

function subscribeToScenario(request: IncomingMessage, response: ServerResponse, state: AppState): void {
  const key = scenarioChannelKey(state);
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
  });
  response.write(": connected\n\n");
  response.write(`event: scenario-state\ndata: ${JSON.stringify(state)}\n\n`);

  const group = subscribers.get(key) ?? new Set<ServerResponse>();
  group.add(response);
  subscribers.set(key, group);

  request.on("close", () => {
    group.delete(response);
    if (group.size === 0) subscribers.delete(key);
  });
}

function publishScenarioState(state: AppState): void {
  const group = subscribers.get(scenarioChannelKey(state));
  if (!group) return;
  const payload = `event: scenario-state\ndata: ${JSON.stringify(state)}\n\n`;
  for (const response of group) {
    response.write(payload);
  }
}

function budgetTree(userId: string) {
  const budgets = new Map(
    states
      .filter((state) => canAccessBudget(state.budget.id, userId))
      .map((state) => [state.budget.id, state.budget]),
  );
  return {
    currentUser: users.get(userId)!,
    budgets: [...budgets.values()],
    scenarios: states.filter((state) => budgets.has(state.budget.id)).map((state) => state.scenario),
    shares: budgetShares.filter((share) => budgets.has(share.budgetId)),
  };
}

function createEmptyBudgetState(input: CreateBudgetRequest, ownerUserId: string): AppState {
  const budget: Budget = {
    id: uniqueId("budget", input.name),
    name: input.name.trim(),
    currency: input.currency.trim().toUpperCase(),
    startPeriod: input.startPeriod,
    endPeriod: input.endPeriod,
    ownerUserId,
  };
  const scenario = {
    id: uniqueId("scenario", "base"),
    budgetId: budget.id,
    name: "Base Case",
  };
  const periods = listPeriodsLocal(budget.startPeriod, budget.endPeriod);
  const series: Series[] = [
    { id: uniqueId("series", "income-subtotal"), scenarioId: scenario.id, key: "income_subtotal", name: "Income Subtotal", type: "calculated", formula: "Sum(Type=Income)" },
    { id: uniqueId("series", "expense-subtotal"), scenarioId: scenario.id, key: "expense_subtotal", name: "Expense Subtotal", type: "calculated", formula: "Sum(Type=Expense)" },
    { id: uniqueId("series", "total"), scenarioId: scenario.id, key: "total", name: "Total", type: "calculated", formula: "income_subtotal - expense_subtotal" },
  ];
  const state: AppState = { budget, scenario, periods, series, values: [], formulaBindings: [] };
  refreshAndRecalculate(state);
  return state;
}

function cloneScenarioState(source: AppState, scenarioName: string): AppState {
  const scenario = {
    id: uniqueId("scenario", scenarioName),
    budgetId: source.budget.id,
    name: scenarioName.trim(),
  };
  const seriesIdMap = new Map(source.series.map((series) => [series.id, uniqueId("series", series.key)]));
  const series: Series[] = source.series.map((item) => ({
    ...item,
    id: seriesIdMap.get(item.id)!,
    scenarioId: scenario.id,
  }));
  const values: Value[] = source.values
    .map((value) => {
      const seriesId = seriesIdMap.get(value.seriesId);
      if (!seriesId) return null;
      return {
        ...value,
        id: `value-${seriesId}-${value.period}`,
        seriesId,
      };
    })
    .filter((value): value is Value => Boolean(value));
  const state: AppState = {
    budget: source.budget,
    scenario,
    periods: [...source.periods],
    series,
    values,
    formulaBindings: [],
  };
  refreshAndRecalculate(state);
  return state;
}

function refreshAndRecalculate(state: AppState): void {
  // Local import cycles are avoided in this server file by using the existing domain APIs indirectly.
  for (const series of state.series) {
    if (!series.formula) continue;
    updateSeriesFormula(state, series.id, series.formula, bindingsFromFormula(state, series.id, series.formula));
  }
  recalculateScenario(state);
}

const server = createConfiguredServer();
server.listen(port, () => {
  const scheme = useHttps ? "https" : "http";
  console.log(`Budget backend listening on ${scheme}://localhost:${port}`);
  if (allowPasswordlessAuth) {
    console.warn("Passwordless user-name authentication is enabled. Do not enable this mode for public production traffic.");
  }
});

function createConfiguredServer() {
  if (!useHttps) {
    return createHttpServer(requestHandler);
  }
  if (!tlsCertFile || !tlsKeyFile) {
    throw new Error("HTTPS=true requires TLS_CERT_FILE and TLS_KEY_FILE");
  }
  return createHttpsServer({
    cert: readFileSync(tlsCertFile),
    key: readFileSync(tlsKeyFile),
  }, requestHandler);
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Dev-User");
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

function validateValueUpdate(body: UpdateValueRequest): void {
  if (
    typeof body.seriesId !== "string" ||
    typeof body.period !== "string" ||
    typeof body.value !== "number" ||
    !Number.isFinite(body.value)
  ) {
    throw httpError(400, "Invalid value update request");
  }
}

function validateSeriesMutation(body: CreateSeriesRequest | UpdateSeriesRequest, partial: boolean): void {
  const allowedTypes = ["income", "expense", "parameter", "calculated"];
  if (!partial && (typeof body.key !== "string" || typeof body.name !== "string" || typeof body.type !== "string")) {
    throw httpError(400, "Series key, name, and type are required");
  }
  if (body.key !== undefined && typeof body.key !== "string") throw httpError(400, "Invalid series key");
  if (body.name !== undefined && typeof body.name !== "string") throw httpError(400, "Invalid series name");
  if (body.type !== undefined && !allowedTypes.includes(body.type)) throw httpError(400, "Invalid series type");
  if (body.formula !== undefined && typeof body.formula !== "string") throw httpError(400, "Invalid formula");
  if (body.unit !== undefined && typeof body.unit !== "string") throw httpError(400, "Invalid unit");
}

function validateCreateBudget(body: CreateBudgetRequest): void {
  if (typeof body.name !== "string" || !body.name.trim()) throw httpError(400, "Budget name is required");
  if (typeof body.currency !== "string" || !body.currency.trim()) throw httpError(400, "Currency is required");
  if (typeof body.startPeriod !== "string" || !/^\d{4}-\d{2}$/.test(body.startPeriod)) {
    throw httpError(400, "Start period must be YYYY-MM");
  }
  if (typeof body.endPeriod !== "string" || !/^\d{4}-\d{2}$/.test(body.endPeriod)) {
    throw httpError(400, "End period must be YYYY-MM");
  }
  if (body.startPeriod > body.endPeriod) throw httpError(400, "Start period must be before end period");
}

function validateCreateScenario(body: CreateScenarioRequest): void {
  if (typeof body.name !== "string" || !body.name.trim()) throw httpError(400, "Scenario name is required");
  if (typeof body.sourceBudgetId !== "string" || typeof body.sourceScenarioId !== "string") {
    throw httpError(400, "Source scenario is required");
  }
}

function listPeriodsLocal(startPeriod: string, endPeriod: string): string[] {
  const [startYear, startMonth] = startPeriod.split("-").map(Number);
  const [endYear, endMonth] = endPeriod.split("-").map(Number);
  const periods: string[] = [];
  let year = startYear;
  let month = startMonth;
  while (year < endYear || (year === endYear && month <= endMonth)) {
    periods.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return periods;
}

function uniqueId(prefix: string, name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || prefix;
  return `${prefix}-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function httpError(statusCode: number, message: string): HttpError {
  return new HttpError(statusCode, message);
}

function loadDotEnv(): void {
  const envFile = process.env.ENV_FILE ?? ".env";
  const envPath = resolve(process.cwd(), envFile);
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = unquoteEnvValue(rawValue);
  }
}

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/g, "") || "/";
}
