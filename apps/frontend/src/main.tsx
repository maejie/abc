import React from "react";
import ReactDOM from "react-dom/client";
import {
  ReactGrid,
  type CellLocation,
  type CellStyle,
  type Column,
  type HeaderCell,
  type Id,
  type MenuOption,
  type NumberCell,
  type ReactGridProps,
  type Row,
  type SelectionMode,
  type TextCell,
} from "@silevis/reactgrid";
import "@silevis/reactgrid/styles.css";
import "./styles.css";
import type {
  AppState,
  BudgetTree,
  CreateBudgetRequest,
  CreateScenarioRequest,
  CreateSeriesRequest,
  Series,
  SeriesType,
  UpdateSeriesRequest,
  Value,
} from "@budget/domain";

type GridCell = TextCell | NumberCell | HeaderCell;
type SeriesForm = {
  id?: string;
  key: string;
  name: string;
  type: SeriesType;
  unit: string;
  formula: string;
};
type DisplaySeries = {
  series: Series;
  indented: boolean;
};
type SeriesModalMode = "create" | "edit";
type FormulaEditorState = {
  seriesId: string;
  draft: string;
  x: number;
  y: number;
};
type BudgetForm = {
  name: string;
  currency: string;
  startPeriod: string;
  endPeriod: string;
};
type ScenarioForm = {
  budgetId: string;
  name: string;
  sourceScenarioId: string;
};
type DevAuthSession = {
  mode: "dev";
  userName: string;
};
type GoogleAuthSession = {
  mode: "google";
  accessToken: string;
  expiresAt: number;
};
type AuthSession = DevAuthSession | GoogleAuthSession;
type GoogleTokenClient = {
  requestAccessToken: (overrideConfig?: { prompt?: "" | "consent" | "select_account" | "none" }) => void;
};
type GoogleTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};
type GoogleErrorResponse = {
  type: string;
  message?: string;
};
type ScriptStatus = "idle" | "loading" | "loaded" | "error";

declare global {
  interface Window {
    google?: {
      accounts: {
        oauth2: {
          initTokenClient: (config: {
            client_id: string;
            scope: string;
            callback: (response: GoogleTokenResponse) => void;
            error_callback?: (response: GoogleErrorResponse) => void;
          }) => GoogleTokenClient;
        };
      };
    };
  }
}

const staticColumns = ["name", "type", "unit", "formula"] as const;
const numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});
const authStorageKey = "budget-auth-session";
const legacyDevUserStorageKey = "budget-dev-user";
const googleIdentityScriptId = "google-identity-services";
const googleScope = "openid email profile";
const googleClientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "").trim();
const allowPasswordlessAuth = import.meta.env.VITE_ALLOW_PASSWORDLESS_AUTH === "true";
const appBasePath = normalizeBasePath(import.meta.env.VITE_APP_BASE_PATH ?? import.meta.env.BASE_URL ?? "/");
const liveUpdateFlashMs = 900;

function App() {
  const [path, setPath] = React.useState(window.location.pathname);
  const [auth, setAuth] = React.useState<AuthSession | null>(() => readStoredAuthSession());

  React.useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  function navigate(nextPath: string) {
    window.history.pushState(null, "", nextPath);
    setPath(nextPath);
  }

  function handleLogin(nextAuth: AuthSession) {
    storeAuthSession(nextAuth);
    setAuth(nextAuth);
  }

  function handleLogout() {
    clearStoredAuthSession();
    setAuth(null);
    navigate(appPath("/"));
  }

  if (!auth) {
    return <LoginPage onLogin={handleLogin} />;
  }

  const route = parseScenarioRoute(path);
  if (route) {
    return (
      <ScenarioPage
        budgetId={route.budgetId}
        scenarioId={route.scenarioId}
        auth={auth}
        onLogout={handleLogout}
        onNavigateHome={() => navigate(appPath("/"))}
      />
    );
  }

  return (
    <BudgetHomePage
      auth={auth}
      onLogout={handleLogout}
      onOpenScenario={(budgetId, scenarioId) => navigate(scenarioPath(budgetId, scenarioId))}
    />
  );
}

function LoginPage(props: { onLogin: (auth: AuthSession) => void }) {
  const [draft, setDraft] = React.useState("alice");
  const [error, setError] = React.useState<string | null>(null);
  const [googlePending, setGooglePending] = React.useState(false);
  const googleScriptStatus = useGoogleIdentityScript(Boolean(googleClientId));
  const googleTokenClientRef = React.useRef<GoogleTokenClient | null>(null);

  React.useEffect(() => {
    if (!googleClientId || googleScriptStatus !== "loaded" || !window.google?.accounts.oauth2) return;
    googleTokenClientRef.current = window.google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: googleScope,
      callback: (response) => {
        setGooglePending(false);
        if (response.error) {
          setError(response.error_description ?? response.error);
          return;
        }
        if (!response.access_token) {
          setError("Google sign-in did not return an access token");
          return;
        }
        props.onLogin({
          mode: "google",
          accessToken: response.access_token,
          expiresAt: Date.now() + Math.max(response.expires_in ?? 3600, 60) * 1000,
        });
      },
      error_callback: (response) => {
        setGooglePending(false);
        setError(response.message ?? "Google sign-in failed");
      },
    });
  }, [googleScriptStatus, props.onLogin]);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const userName = draft.trim();
    if (!userName) return;
    setError(null);
    props.onLogin({ mode: "dev", userName });
  }

  function handleGoogleLogin() {
    setError(null);
    if (!googleClientId) {
      setError("Google sign-in is not configured for this frontend");
      return;
    }
    if (!googleTokenClientRef.current) {
      setError(googleScriptStatus === "error" ? "Failed to load Google sign-in" : "Google sign-in is still loading");
      return;
    }
    setGooglePending(true);
    googleTokenClientRef.current.requestAccessToken({ prompt: "select_account" });
  }

  return (
    <main className="page login-page">
      <section className="modal-window">
        <h1>Budget Planner</h1>
        <p>Sign in with Google to access your budgets.</p>
        {allowPasswordlessAuth && (
          <form className="series-form" onSubmit={handleSubmit}>
            <label>
              User Name
              <input value={draft} onChange={(event) => setDraft(event.target.value)} required />
            </label>
            <div className="panel-actions">
              <button type="submit">Sign In Without Password</button>
            </div>
          </form>
        )}
        {googleClientId && (
          <div className="login-provider-panel">
            {allowPasswordlessAuth && <div className="login-divider">or</div>}
            <button
              type="button"
              className="secondary-button google-sign-in-button"
              disabled={googlePending || googleScriptStatus === "loading"}
              onClick={handleGoogleLogin}
            >
              {googlePending ? "Signing in..." : "Continue with Google"}
            </button>
          </div>
        )}
        {!googleClientId && !allowPasswordlessAuth && (
          <div className="error-banner login-error">Google sign-in is not configured.</div>
        )}
        {error && <div className="error-banner login-error">{error}</div>}
      </section>
    </main>
  );
}

function BudgetHomePage(props: {
  auth: AuthSession;
  onLogout: () => void;
  onOpenScenario: (budgetId: string, scenarioId: string) => void;
}) {
  const { auth, onLogout, onOpenScenario } = props;
  const [tree, setTree] = React.useState<BudgetTree | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [budgetForm, setBudgetForm] = React.useState<BudgetForm>(blankBudgetForm());
  const [budgetModalOpen, setBudgetModalOpen] = React.useState(false);
  const [scenarioForm, setScenarioForm] = React.useState<ScenarioForm | null>(null);
  const [shareForm, setShareForm] = React.useState<{ budgetId: string; userName: string } | null>(null);

  React.useEffect(() => {
    authFetch(appPath("/api/budgets"), auth)
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<BudgetTree>;
      })
      .then(setTree)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Failed to load budgets"));
  }, [auth]);

  if (error) {
    return (
      <main className="page">
        <div className="error-banner">{error}</div>
        <div className="panel-actions page-actions">
          <button type="button" className="secondary-button" onClick={onLogout}>Sign Out</button>
        </div>
      </main>
    );
  }

  if (!tree) {
    return <main className="page"><div className="loading">Loading budgets...</div></main>;
  }

  async function handleCreateBudget(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const payload: CreateBudgetRequest = budgetForm;
      const response = await authFetch(appPath("/api/budgets"), auth, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Budget creation failed");
      const body = (await response.json()) as { state: AppState; tree: BudgetTree };
      setTree(body.tree);
      setBudgetForm(blankBudgetForm());
      setBudgetModalOpen(false);
      onOpenScenario(body.state.budget.id, body.state.scenario.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Budget creation failed");
    }
  }

  async function handleCreateScenario(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!scenarioForm) return;
    setError(null);
    try {
      const payload: CreateScenarioRequest = {
        name: scenarioForm.name,
        sourceBudgetId: scenarioForm.budgetId,
        sourceScenarioId: scenarioForm.sourceScenarioId,
      };
      const response = await authFetch(appPath(`/api/budgets/${encodeURIComponent(scenarioForm.budgetId)}/scenarios`), auth, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Scenario creation failed");
      const body = (await response.json()) as { state: AppState; tree: BudgetTree };
      setTree(body.tree);
      setScenarioForm(null);
      onOpenScenario(body.state.budget.id, body.state.scenario.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Scenario creation failed");
    }
  }

  async function handleShareBudget(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!shareForm) return;
    setError(null);
    try {
      const response = await authFetch(appPath(`/api/budgets/${encodeURIComponent(shareForm.budgetId)}/shares`), auth, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userName: shareForm.userName }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Budget share failed");
      const body = (await response.json()) as { tree: BudgetTree };
      setTree(body.tree);
      setShareForm(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Budget share failed");
    }
  }

  return (
    <main className="page">
      <header className="app-header">
        <div>
          <h1>Budget Planner</h1>
          <p>{tree.currentUser.name} · Select a scenario to view and edit its monthly budget.</p>
        </div>
        <div className="header-actions">
          <button type="button" onClick={() => setBudgetModalOpen(true)}>New Budget</button>
          <button type="button" className="secondary-button" onClick={onLogout}>Sign Out</button>
        </div>
      </header>
      {error && <div className="error-banner">{error}</div>}
      <section className="budget-tree" aria-label="Budget and scenario tree">
        {tree.budgets.map((budget) => {
          const scenarios = tree.scenarios.filter((scenario) => scenario.budgetId === budget.id);
          return (
            <div className="budget-group" key={budget.id}>
              <div className="budget-group-header">
                <div>
                  <h2>{budget.name}</h2>
                  <p>{budget.currency} · {budget.startPeriod} to {budget.endPeriod} · {budget.ownerUserId === tree.currentUser.id ? "Owner" : "Shared"}</p>
                </div>
                <div className="header-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setScenarioForm({
                      budgetId: budget.id,
                      name: "",
                      sourceScenarioId: scenarios[0]?.id ?? "",
                    })}
                  >
                    New Scenario
                  </button>
                  {budget.ownerUserId === tree.currentUser.id && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => setShareForm({ budgetId: budget.id, userName: "" })}
                    >
                      Share
                    </button>
                  )}
                </div>
              </div>
              {tree.shares.filter((share) => share.budgetId === budget.id).length > 0 && (
                <p className="share-list">
                  Shared with {tree.shares.filter((share) => share.budgetId === budget.id).map((share) => share.userId).join(", ")}
                </p>
              )}
              <div className="scenario-list">
                {scenarios.map((scenario) => (
                  <button
                    className="scenario-button"
                    key={scenario.id}
                    type="button"
                    onClick={() => onOpenScenario(budget.id, scenario.id)}
                  >
                    {scenario.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </section>
      {budgetModalOpen && (
        <BudgetModal
          form={budgetForm}
          onChange={setBudgetForm}
          onSave={handleCreateBudget}
          onClose={() => {
            setBudgetForm(blankBudgetForm());
            setBudgetModalOpen(false);
          }}
        />
      )}
      {scenarioForm && (
        <ScenarioModal
          tree={tree}
          form={scenarioForm}
          onChange={setScenarioForm}
          onSave={handleCreateScenario}
          onClose={() => setScenarioForm(null)}
        />
      )}
      {shareForm && (
        <ShareBudgetModal
          form={shareForm}
          onChange={setShareForm}
          onSave={handleShareBudget}
          onClose={() => setShareForm(null)}
        />
      )}
    </main>
  );
}

function ScenarioPage(props: {
  budgetId: string;
  scenarioId: string;
  auth: AuthSession;
  onLogout: () => void;
  onNavigateHome: () => void;
}) {
  const { budgetId, scenarioId, auth, onLogout, onNavigateHome } = props;
  const [state, setState] = React.useState<AppState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [savingCell, setSavingCell] = React.useState<string | null>(null);
  const [seriesForm, setSeriesForm] = React.useState<SeriesForm>(blankSeriesForm());
  const [seriesModalMode, setSeriesModalMode] = React.useState<SeriesModalMode | null>(null);
  const [formulaEditor, setFormulaEditor] = React.useState<FormulaEditorState | null>(null);
  const [focusedLocation, setFocusedLocation] = React.useState<CellLocation | null>(null);
  const [flashedCells, setFlashedCells] = React.useState<Set<string>>(() => new Set());
  const flashTimerRef = React.useRef<number | null>(null);
  const apiBase = scenarioApiBase(budgetId, scenarioId);

  React.useEffect(() => {
    setState(null);
    setError(null);
    setFormulaEditor(null);
    setSeriesModalMode(null);
    setFocusedLocation(null);
    setFlashedCells(new Set());
    authFetch(`${apiBase}/state`, auth)
      .then(async (response) => {
        if (!response.ok) throw new Error(await response.text());
        return response.json() as Promise<AppState>;
      })
      .then(setState)
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Failed to load budget"));
  }, [apiBase, auth]);

  React.useEffect(() => {
    const events = new EventSource(authEventStreamUrl(`${apiBase}/events`, auth));
    events.addEventListener("scenario-state", (event) => {
      try {
        applyLiveState(JSON.parse((event as MessageEvent<string>).data) as AppState);
      } catch {
        setError("Failed to apply live update");
      }
    });
    events.onerror = () => {
      setError("Live updates disconnected. The browser will retry automatically.");
    };
    return () => events.close();
  }, [apiBase, auth]);

  React.useEffect(() => {
    return () => {
      if (flashTimerRef.current !== null) {
        window.clearTimeout(flashTimerRef.current);
      }
    };
  }, []);

  function applyLiveState(nextState: AppState) {
    setState((current) => {
      if (current) {
        const changed = changedValueCellKeys(current.values, nextState.values);
        if (changed.size > 0) {
          setFlashedCells(changed);
          if (flashTimerRef.current !== null) {
            window.clearTimeout(flashTimerRef.current);
          }
          flashTimerRef.current = window.setTimeout(() => {
            setFlashedCells(new Set());
            flashTimerRef.current = null;
          }, liveUpdateFlashMs);
        }
      }
      return nextState;
    });
  }

  if (error && !state) {
    return (
      <main className="page">
        <div className="error-banner">{error}</div>
        <div className="panel-actions page-actions">
          <button type="button" className="secondary-button" onClick={onNavigateHome}>Scenarios</button>
          <button type="button" className="secondary-button" onClick={onLogout}>Sign Out</button>
        </div>
      </main>
    );
  }

  if (!state) {
    return <main className="page"><div className="loading">Loading budget...</div></main>;
  }

  const columns: Column[] = [
    { columnId: "name", width: 220 },
    { columnId: "type", width: 110 },
    { columnId: "unit", width: 130 },
    { columnId: "formula", width: 220 },
    ...state.periods.map((period) => ({ columnId: period, width: 120 })),
  ];

  const rows = buildRows(state, savingCell, flashedCells);

  const handleCellsChanged: NonNullable<ReactGridProps["onCellsChanged"]> = (changes) => {
    void handleTextCellChanges(changes);
  };

  async function handleTextCellChanges(changes: Parameters<NonNullable<ReactGridProps["onCellsChanged"]>>[0]) {
    const change = changes[0];
    if (!state || !change || change.type !== "number") return;
    const period = String(change.columnId);
    if (!state.periods.includes(period)) return;

    const seriesId = String(change.rowId);
    const series = state.series.find((item) => item.id === seriesId);
    if (!series || !isEditableSeries(series)) return;

    const nextValue = change.newCell.value;
    if (!Number.isFinite(nextValue)) {
      setError("Enter a numeric value.");
      return;
    }

    setSavingCell(`${seriesId}:${period}`);
    setError(null);
    try {
      const response = await authFetch(`${apiBase}/values`, auth, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seriesId, period, value: nextValue }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Update failed");
      const body = (await response.json()) as { updatedValues: Value[] };
      setState((current) => current && { ...current, values: applyUpdatedValues(current.values, body.updatedValues) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Update failed");
    } finally {
      setSavingCell(null);
    }
  }

  function openCreateSeriesModal() {
    setSeriesForm(blankSeriesForm());
    setSeriesModalMode("create");
  }

  function openEditSeriesModal(seriesId: string) {
    const series = state?.series.find((item) => item.id === seriesId);
    if (!series) return;
    setSeriesForm(formFromSeries(series));
    setSeriesModalMode("edit");
  }

  async function handleSaveSeries(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const payload = seriesPayload(seriesForm);
    try {
      const response = await authFetch(seriesForm.id ? `${apiBase}/series/${encodeURIComponent(seriesForm.id)}` : `${apiBase}/series`, auth, {
        method: seriesForm.id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Series save failed");
      const body = (await response.json()) as { state: AppState; updatedValues: Value[] };
      setState(body.state);
      setSeriesModalMode(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Series save failed");
    }
  }

  async function handleDeleteSeries(seriesId: string) {
    if (!state) return;
    const series = state.series.find((item) => item.id === seriesId);
    if (!series) return;
    const seriesName = series.name || "this series";
    if (!window.confirm(`Delete ${seriesName}?`)) return;
    setError(null);
    try {
      const response = await authFetch(`${apiBase}/series/${encodeURIComponent(seriesId)}`, auth, { method: "DELETE" });
      if (!response.ok) throw new Error((await response.json()).error ?? "Series delete failed");
      const body = (await response.json()) as { state: AppState; updatedValues: Value[] };
      setState(body.state);
      if (formulaEditor?.seriesId === seriesId) setFormulaEditor(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Series delete failed");
    }
  }

  function handleContextMenu(
    selectedRowIds: Id[],
    _selectedColIds: Id[],
    _selectionMode: SelectionMode,
    _menuOptions: MenuOption[],
    selectedRanges: CellLocation[][],
  ): MenuOption[] {
    if (!state) return [];
    const rowId = contextSeriesRowId(selectedRowIds, selectedRanges, state);
    const options: MenuOption[] = [
      {
        id: "add-series",
        label: "新規行追加",
        handler: () => openCreateSeriesModal(),
      },
    ];

    if (rowId) {
      options.push(
        {
          id: "edit-series",
          label: "行の編集",
          handler: () => openEditSeriesModal(rowId),
        },
        {
          id: "delete-series",
          label: "行の削除",
          handler: () => void handleDeleteSeries(rowId),
        },
      );
    }

    return options;
  }

  function handleFocusLocationChanged(location: CellLocation) {
    setFocusedLocation(location);
  }

  function handleGridClick(event: React.MouseEvent<HTMLElement>) {
    if (!state) return;
    const location = locationFromGridEvent(event, rows, columns);
    if (!location || location.rowId === "header") return;

    const series = state.series.find((item) => item.id === String(location.rowId));
    if (!series) return;

    if (location.columnId === "formula") {
      openFormulaEditor(series);
      return;
    }

    if (formulaEditor) {
      insertSeriesReference(series);
    }
  }

  function handleGridKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== "Enter" || !state || !focusedLocation || focusedLocation.columnId !== "formula") return;
    const series = state.series.find((item) => item.id === String(focusedLocation.rowId));
    if (!series) return;
    event.preventDefault();
    openFormulaEditor(series);
  }

  function openFormulaEditor(series: Series) {
    setFormulaEditor({
      seriesId: series.id,
      draft: series.formula ?? "",
      x: 420,
      y: 110,
    });
  }

  function insertSeriesReference(series: Series) {
    setFormulaEditor((current) => {
      if (!current || current.seriesId === series.id) return current;
      const separator = current.draft.trim().length > 0 && !/\s$/.test(current.draft) ? " " : "";
      return { ...current, draft: `${current.draft}${separator}${series.key}` };
    });
  }

  async function handleSaveFormula() {
    if (!state || !formulaEditor) return;
    const series = state.series.find((item) => item.id === formulaEditor.seriesId);
    if (!series) return;
    setError(null);
    try {
      const response = await authFetch(`${apiBase}/series/${encodeURIComponent(series.id)}`, auth, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...seriesPayload(formFromSeries(series)), formula: formulaEditor.draft || undefined }),
      });
      if (!response.ok) throw new Error((await response.json()).error ?? "Formula save failed");
      const body = (await response.json()) as { state: AppState; updatedValues: Value[] };
      setState(body.state);
      setFormulaEditor(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Formula save failed");
    }
  }

  return (
    <main className="page">
      <header className="app-header">
        <div>
          <h1>{state.budget.name}</h1>
          <p>{state.scenario.name} · {state.budget.currency} · {state.budget.startPeriod} to {state.budget.endPeriod}</p>
        </div>
        <div className="header-actions">
          <button type="button" className="secondary-button" onClick={onNavigateHome}>Scenarios</button>
          <button type="button" className="secondary-button" onClick={onLogout}>Sign Out</button>
        </div>
      </header>
      {error && <div className="error-banner">{error}</div>}
      <section className="grid-shell" aria-label="Monthly budget grid">
        <div onClickCapture={handleGridClick} onKeyDownCapture={handleGridKeyDown}>
        <ReactGrid
          rows={rows}
          columns={columns}
          onCellsChanged={handleCellsChanged}
          onContextMenu={handleContextMenu}
          onFocusLocationChanged={handleFocusLocationChanged}
          stickyTopRows={1}
          stickyLeftColumns={1}
          enableRangeSelection
        />
        </div>
      </section>
      {seriesModalMode && (
        <SeriesModal
          mode={seriesModalMode}
          form={seriesForm}
          onChange={setSeriesForm}
          onSave={handleSaveSeries}
          onClose={() => setSeriesModalMode(null)}
        />
      )}
      {formulaEditor && (
        <FormulaEditorWindow
          state={state}
          editor={formulaEditor}
          onChange={setFormulaEditor}
          onSave={handleSaveFormula}
          onClose={() => setFormulaEditor(null)}
        />
      )}
    </main>
  );
}

function BudgetModal(props: {
  form: BudgetForm;
  onChange: (form: BudgetForm) => void;
  onSave: (event: React.FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const { form, onChange, onSave, onClose } = props;
  const update = (patch: Partial<BudgetForm>) => onChange({ ...form, ...patch });

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-window" role="dialog" aria-modal="true" aria-label="New budget" onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <h2>New Budget</h2>
          <button type="button" className="secondary-button" onClick={onClose}>Close</button>
        </div>
        <form className="series-form" onSubmit={onSave}>
          <label>
            Name
            <input value={form.name} onChange={(event) => update({ name: event.target.value })} required />
          </label>
          <label>
            Currency
            <input value={form.currency} onChange={(event) => update({ currency: event.target.value })} required />
          </label>
          <div className="period-row">
            <label>
              Start
              <input type="month" value={form.startPeriod} onChange={(event) => update({ startPeriod: event.target.value })} required />
            </label>
            <label>
              End
              <input type="month" value={form.endPeriod} onChange={(event) => update({ endPeriod: event.target.value })} required />
            </label>
          </div>
          <div className="panel-actions">
            <button type="submit">Create</button>
            <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ScenarioModal(props: {
  tree: BudgetTree;
  form: ScenarioForm;
  onChange: (form: ScenarioForm) => void;
  onSave: (event: React.FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const { tree, form, onChange, onSave, onClose } = props;
  const sourceScenarios = tree.scenarios.filter((scenario) => scenario.budgetId === form.budgetId);
  const update = (patch: Partial<ScenarioForm>) => onChange({ ...form, ...patch });

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-window" role="dialog" aria-modal="true" aria-label="New scenario" onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <h2>New Scenario</h2>
          <button type="button" className="secondary-button" onClick={onClose}>Close</button>
        </div>
        <form className="series-form" onSubmit={onSave}>
          <label>
            Name
            <input value={form.name} onChange={(event) => update({ name: event.target.value })} required />
          </label>
          <label>
            Copy From
            <select value={form.sourceScenarioId} onChange={(event) => update({ sourceScenarioId: event.target.value })} required>
              {sourceScenarios.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
              ))}
            </select>
          </label>
          <div className="panel-actions">
            <button type="submit">Create</button>
            <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function ShareBudgetModal(props: {
  form: { budgetId: string; userName: string };
  onChange: (form: { budgetId: string; userName: string }) => void;
  onSave: (event: React.FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const { form, onChange, onSave, onClose } = props;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-window" role="dialog" aria-modal="true" aria-label="Share budget" onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <h2>Share Budget</h2>
          <button type="button" className="secondary-button" onClick={onClose}>Close</button>
        </div>
        <form className="series-form" onSubmit={onSave}>
          <label>
            User Name
            <input
              value={form.userName}
              onChange={(event) => onChange({ ...form, userName: event.target.value })}
              required
            />
          </label>
          <div className="panel-actions">
            <button type="submit">Share</button>
            <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </section>
    </div>
  );
}

function SeriesModal(props: {
  mode: SeriesModalMode;
  form: SeriesForm;
  onChange: (form: SeriesForm) => void;
  onSave: (event: React.FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const { mode, form, onChange, onSave, onClose } = props;
  const update = (patch: Partial<SeriesForm>) => onChange({ ...form, ...patch });

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="modal-window" role="dialog" aria-modal="true" aria-label="Series editor" onMouseDown={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <h2>{mode === "create" ? "New Series" : "Edit Series"}</h2>
          <button type="button" className="secondary-button" onClick={onClose}>Close</button>
        </div>
        <form className="series-form" onSubmit={onSave}>
        <label>
          Name
          <input value={form.name} onChange={(event) => update({ name: event.target.value })} required />
        </label>
        <label>
          Key
          <input value={form.key} onChange={(event) => update({ key: event.target.value })} required pattern="[A-Za-z_][A-Za-z0-9_]*" />
        </label>
        <label>
          Type
          <select value={form.type} onChange={(event) => update({ type: event.target.value as SeriesType })}>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
            <option value="parameter">Parameter</option>
            <option value="calculated">Calculated</option>
          </select>
        </label>
        <label>
          Unit
          <input value={form.unit} onChange={(event) => update({ unit: event.target.value })} />
        </label>
        <label>
          Formula
          <input value={form.formula} onChange={(event) => update({ formula: event.target.value })} placeholder="revenue - cloudCost" />
        </label>
        <div className="panel-actions">
          <button type="submit">Save</button>
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
        </div>
      </form>
      </section>
    </div>
  );
}

function FormulaEditorWindow(props: {
  state: AppState;
  editor: FormulaEditorState;
  onChange: (editor: FormulaEditorState | null | ((current: FormulaEditorState | null) => FormulaEditorState | null)) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  const { state, editor, onChange, onSave, onClose } = props;
  const series = state.series.find((item) => item.id === editor.seriesId);

  function startDrag(event: React.MouseEvent<HTMLDivElement>) {
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = editor.x;
    const originY = editor.y;

    const move = (moveEvent: MouseEvent) => {
      onChange((current) => current && {
        ...current,
        x: Math.max(8, originX + moveEvent.clientX - startX),
        y: Math.max(8, originY + moveEvent.clientY - startY),
      });
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };

    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  return (
    <section
      className="formula-window"
      style={{ left: editor.x, top: editor.y }}
      role="dialog"
      aria-label="Formula editor"
    >
      <div className="floating-titlebar" onMouseDown={startDrag}>
        <h2>{series ? `Formula: ${series.name}` : "Formula"}</h2>
        <button type="button" className="secondary-button" onClick={onClose}>Close</button>
      </div>
      <textarea
        value={editor.draft}
        onChange={(event) => onChange({ ...editor, draft: event.target.value })}
        autoFocus
      />
      <p className="formula-hint">Click a series row in the grid to insert its key.</p>
      <div className="panel-actions">
        <button type="button" onClick={onSave}>Save</button>
        <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
      </div>
    </section>
  );
}

function buildRows(state: AppState, savingCell: string | null, flashedCells: Set<string>): Row<GridCell>[] {
  const headerCells: GridCell[] = [
    headerCell("Series"),
    headerCell("Type"),
    headerCell("Unit"),
    headerCell("Formula"),
    ...state.periods.map((period) => headerCell(period, "month-header")),
  ];

  const seriesRows = orderSeriesForDisplay(state)
    .map(({ series, indented }) => {
      const rowClass = [
        series.formula ? "formula-row" : "",
        series.type === "parameter" ? "parameter-row" : "",
        series.type === "calculated" ? "calculated-row" : "",
        isSubtotalSeries(series) ? "subtotal-row" : "",
        isTotalSeries(series) ? "total-row" : "",
      ].filter(Boolean).join(" ");

      return {
        rowId: series.id,
        height: 38,
        cells: [
          textCell(`${indented ? "  " : ""}${series.name}`, `name-cell ${indented ? "indented" : ""} ${rowClass}`, true),
          textCell(series.type, `type-cell ${rowClass}`, true),
          textCell(series.unit ?? "", rowClass, true),
          textCell(series.formula ?? "", `formula-cell ${rowClass}`, true),
          ...state.periods.map((period) => valueCell(state, series, period, savingCell, flashedCells, rowClass)),
        ],
      };
    });

  return [{ rowId: "header", height: 40, cells: headerCells }, ...seriesRows];
}

function orderSeriesForDisplay(state: AppState): DisplaySeries[] {
  const rows: DisplaySeries[] = [];
  const emitted = new Set<string>();
  const byId = new Map(state.series.map((series) => [series.id, series]));
  const originalIndex = new Map(state.series.map((series, index) => [series.id, index]));

  appendSectionRows(state, rows, emitted, byId, originalIndex, "income");
  pushSpecialRow(state, rows, emitted, "income_subtotal");
  appendSectionRows(state, rows, emitted, byId, originalIndex, "expense");
  pushSpecialRow(state, rows, emitted, "expense_subtotal");
  pushSpecialRow(state, rows, emitted, "total");

  const otherCalculated = state.series
    .filter((series) => series.type === "calculated" && !isSubtotalSeries(series) && !isTotalSeries(series))
    .sort((a, b) => (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0));
  for (const series of otherCalculated) {
    pushRow(rows, emitted, series, false);
    appendReferencedParameters(state, rows, emitted, byId, series);
  }

  const unreferencedParameters = state.series
    .filter((series) => series.type === "parameter" && !emitted.has(series.id))
    .sort((a, b) => (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0));
  for (const series of unreferencedParameters) {
    pushRow(rows, emitted, series, false);
  }

  return rows;
}

function appendSectionRows(
  state: AppState,
  rows: DisplaySeries[],
  emitted: Set<string>,
  byId: Map<string, Series>,
  originalIndex: Map<string, number>,
  type: "income" | "expense",
): void {
  const topLevelSeries = state.series
    .filter((series) => series.type === type)
    .sort((a, b) => (originalIndex.get(a.id) ?? 0) - (originalIndex.get(b.id) ?? 0));

  for (const series of topLevelSeries) {
    pushRow(rows, emitted, series, false);
    appendReferencedParameters(state, rows, emitted, byId, series);
  }
}

function appendReferencedParameters(
  state: AppState,
  rows: DisplaySeries[],
  emitted: Set<string>,
  byId: Map<string, Series>,
  series: Series,
): void {
  const bindings = state.formulaBindings.filter((binding) => binding.targetSeriesId === series.id);
  for (const binding of bindings) {
    const source = byId.get(binding.sourceSeriesId);
    if (source?.type === "parameter") {
      pushRow(rows, emitted, source, true);
    }
  }
}

function pushSpecialRow(state: AppState, rows: DisplaySeries[], emitted: Set<string>, key: string): void {
  const series = state.series.find((item) => item.key === key);
  if (series) pushRow(rows, emitted, series, false);
}

function pushRow(rows: DisplaySeries[], emitted: Set<string>, series: Series, indented: boolean): void {
  if (emitted.has(series.id)) return;
  emitted.add(series.id);
  rows.push({ series, indented });
}

function isSubtotalSeries(series: Series): boolean {
  return series.key === "income_subtotal" || series.key === "expense_subtotal";
}

function isTotalSeries(series: Series): boolean {
  return series.key === "total";
}

function contextSeriesRowId(selectedRowIds: Id[], selectedRanges: CellLocation[][], state: AppState): string | null {
  const candidates = [
    ...selectedRowIds,
    ...selectedRanges.flat().map((location) => location.rowId),
  ].map(String);

  return candidates.find((rowId) => state.series.some((series) => series.id === rowId)) ?? null;
}

function locationFromGridEvent(
  event: React.MouseEvent<HTMLElement>,
  rows: Row<GridCell>[],
  columns: Column[],
): CellLocation | null {
  const target = event.target instanceof HTMLElement ? event.target : null;
  const cell = target?.closest<HTMLElement>("[data-cell-rowidx][data-cell-colidx]");
  if (!cell) return null;
  const rowIndex = Number(cell.dataset.cellRowidx);
  const columnIndex = Number(cell.dataset.cellColidx);
  const row = rows[rowIndex];
  const column = columns[columnIndex];
  if (!row || !column) return null;
  return { rowId: row.rowId, columnId: column.columnId };
}

function valueCell(
  state: AppState,
  series: Series,
  period: string,
  savingCell: string | null,
  flashedCells: Set<string>,
  rowClass: string,
): GridCell {
  const value = state.values.find((item) => item.seriesId === series.id && item.period === period);
  const editable = isEditableSeries(series);
  if (value?.status === "error") {
    return textCell("ERROR", `value-cell error-cell ${rowClass}`, true);
  }

  const classes = [
    rowClass,
    "value-cell",
    editable ? "editable-cell" : "locked-cell",
    series.formula ? "formula-row" : "",
    (value?.value ?? 0) < 0 ? "negative-cell" : "",
    savingCell === `${series.id}:${period}` ? "saving-cell" : "",
    flashedCells.has(`${series.id}:${period}`) ? "live-updated-cell" : "",
  ].filter(Boolean).join(" ");

  return numberCell(value?.value ?? 0, classes, !editable, (value?.value ?? 0) < 0 ? { color: "#b42318" } : undefined);
}

function textCell(text: string, className = "", nonEditable = false, style?: CellStyle): GridCell {
  return { type: "text", text, className, nonEditable, style };
}

function numberCell(value: number, className = "", nonEditable = false, style?: CellStyle): GridCell {
  return { type: "number", value, format: numberFormat, className, nonEditable, style };
}

function headerCell(text: string, className = ""): GridCell {
  return { type: "header", text, className: `header-cell align-center ${className}`.trim(), nonEditable: true };
}

function isEditableSeries(series: Series): boolean {
  return series.type === "parameter" || ((series.type === "income" || series.type === "expense") && !series.formula);
}

function formFromSeries(series: Series): SeriesForm {
  return {
    id: series.id,
    key: series.key,
    name: series.name,
    type: series.type,
    unit: series.unit ?? "",
    formula: series.formula ?? "",
  };
}

function blankSeriesForm(): SeriesForm {
  return {
    key: "",
    name: "",
    type: "expense",
    unit: "",
    formula: "",
  };
}

function blankBudgetForm(): BudgetForm {
  return {
    name: "",
    currency: "JPY",
    startPeriod: "2026-01",
    endPeriod: "2026-06",
  };
}

function seriesPayload(form: SeriesForm): CreateSeriesRequest | UpdateSeriesRequest {
  return {
    key: form.key,
    name: form.name,
    type: form.type,
    unit: form.unit || undefined,
    formula: form.formula || undefined,
  };
}

function parseScenarioRoute(path: string): { budgetId: string; scenarioId: string } | null {
  const routePath = stripAppBasePath(path);
  if (!routePath) return null;
  const match = /^\/budgets\/([^/]+)\/scenarios\/([^/]+)$/.exec(routePath);
  if (!match) return null;
  return {
    budgetId: decodeURIComponent(match[1]),
    scenarioId: decodeURIComponent(match[2]),
  };
}

function scenarioPath(budgetId: string, scenarioId: string): string {
  return appPath(`/budgets/${encodeURIComponent(budgetId)}/scenarios/${encodeURIComponent(scenarioId)}`);
}

function scenarioApiBase(budgetId: string, scenarioId: string): string {
  return appPath(`/api/budgets/${encodeURIComponent(budgetId)}/scenarios/${encodeURIComponent(scenarioId)}`);
}

function appPath(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (appBasePath === "/") return normalizedPath;
  return `${appBasePath}${normalizedPath}`;
}

function stripAppBasePath(path: string): string | null {
  if (appBasePath === "/") return path;
  if (path === appBasePath) return "/";
  if (!path.startsWith(`${appBasePath}/`)) return null;
  return path.slice(appBasePath.length) || "/";
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/g, "") || "/";
}

function authFetch(url: string, auth: AuthSession, init: RequestInit = {}): Promise<Response> {
  if (auth.mode === "google" && auth.expiresAt <= Date.now()) {
    return Promise.reject(new Error("Google session expired. Sign in again."));
  }
  const headers = new Headers(init.headers);
  if (auth.mode === "google") {
    headers.set("Authorization", `Bearer ${auth.accessToken}`);
  } else {
    headers.set("X-Dev-User", auth.userName);
  }
  return fetch(url, { ...init, headers });
}

function authEventStreamUrl(url: string, auth: AuthSession): string {
  const streamUrl = new URL(url, window.location.origin);
  if (auth.mode === "google") {
    streamUrl.searchParams.set("accessToken", auth.accessToken);
  } else {
    streamUrl.searchParams.set("devUser", auth.userName);
  }
  return streamUrl.toString();
}

function useGoogleIdentityScript(enabled: boolean): ScriptStatus {
  const [status, setStatus] = React.useState<ScriptStatus>(() => {
    if (!enabled) return "idle";
    return window.google?.accounts.oauth2 ? "loaded" : "loading";
  });

  React.useEffect(() => {
    if (!enabled) {
      setStatus("idle");
      return;
    }
    if (window.google?.accounts.oauth2) {
      setStatus("loaded");
      return;
    }

    const existingScript = document.getElementById(googleIdentityScriptId);
    const script = existingScript instanceof HTMLScriptElement ? existingScript : document.createElement("script");
    if (!(existingScript instanceof HTMLScriptElement)) {
      script.id = googleIdentityScriptId;
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.head.append(script);
    }

    const handleLoad = () => setStatus("loaded");
    const handleError = () => setStatus("error");
    setStatus("loading");
    script.addEventListener("load", handleLoad);
    script.addEventListener("error", handleError);
    return () => {
      script.removeEventListener("load", handleLoad);
      script.removeEventListener("error", handleError);
    };
  }, [enabled]);

  return status;
}

function readStoredAuthSession(): AuthSession | null {
  const rawStored = localStorage.getItem(authStorageKey);
  if (rawStored) {
    try {
      const parsed = JSON.parse(rawStored) as unknown;
      if (isAuthSession(parsed)) {
        if (parsed.mode === "google" && parsed.expiresAt <= Date.now()) {
          clearStoredAuthSession();
          return null;
        }
        return parsed;
      }
    } catch {
      clearStoredAuthSession();
      return null;
    }
  }

  const legacyUserName = localStorage.getItem(legacyDevUserStorageKey)?.trim();
  if (!allowPasswordlessAuth || !legacyUserName) return null;
  return { mode: "dev", userName: legacyUserName };
}

function storeAuthSession(auth: AuthSession): void {
  localStorage.setItem(authStorageKey, JSON.stringify(auth));
  if (auth.mode === "dev") {
    localStorage.setItem(legacyDevUserStorageKey, auth.userName);
    return;
  }
  localStorage.removeItem(legacyDevUserStorageKey);
}

function clearStoredAuthSession(): void {
  localStorage.removeItem(authStorageKey);
  localStorage.removeItem(legacyDevUserStorageKey);
}

function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== "object") return false;
  if ("mode" in value && value.mode === "dev") {
    return allowPasswordlessAuth && "userName" in value && typeof value.userName === "string" && value.userName.trim().length > 0;
  }
  if ("mode" in value && value.mode === "google") {
    return (
      "accessToken" in value &&
      typeof value.accessToken === "string" &&
      value.accessToken.length > 0 &&
      "expiresAt" in value &&
      typeof value.expiresAt === "number" &&
      Number.isFinite(value.expiresAt)
    );
  }
  return false;
}

function applyUpdatedValues(current: Value[], updated: Value[]): Value[] {
  const next = new Map(current.map((value) => [`${value.seriesId}:${value.period}`, value]));
  for (const value of updated) {
    next.set(`${value.seriesId}:${value.period}`, value);
  }
  return [...next.values()];
}

function changedValueCellKeys(previous: Value[], next: Value[]): Set<string> {
  const previousByKey = new Map(previous.map((value) => [`${value.seriesId}:${value.period}`, value]));
  const changed = new Set<string>();
  for (const value of next) {
    const key = `${value.seriesId}:${value.period}`;
    const previousValue = previousByKey.get(key);
    if (
      !previousValue ||
      previousValue.value !== value.value ||
      previousValue.status !== value.status ||
      previousValue.errorMessage !== value.errorMessage
    ) {
      changed.add(key);
    }
  }
  return changed;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
