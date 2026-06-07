export interface Budget {
  id: string;
  name: string;
  currency: string;
  startPeriod: string;
  endPeriod: string;
  ownerUserId: string;
}

export type AuthProvider = "dev" | "google";

export interface User {
  id: string;
  name: string;
  authProvider: AuthProvider;
  email?: string;
}

export interface BudgetShare {
  budgetId: string;
  userId: string;
}

export interface Scenario {
  id: string;
  budgetId: string;
  name: string;
}

export type SeriesType = "income" | "expense" | "parameter" | "calculated";

export interface Series {
  id: string;
  scenarioId: string;
  key: string;
  name: string;
  type: SeriesType;
  formula?: string;
  unit?: string;
}

export type ValueStatus = "ok" | "manual" | "error";

export interface Value {
  id: string;
  seriesId: string;
  period: string;
  value: number | null;
  status: ValueStatus;
  errorMessage?: string;
}

export interface FormulaBinding {
  id: string;
  targetSeriesId: string;
  variableName: string;
  sourceSeriesId: string;
}

export interface AppState {
  budget: Budget;
  scenario: Scenario;
  periods: string[];
  series: Series[];
  values: Value[];
  formulaBindings: FormulaBinding[];
}

export interface BudgetTree {
  currentUser: User;
  budgets: Budget[];
  scenarios: Scenario[];
  shares: BudgetShare[];
}

export interface CreateBudgetRequest {
  name: string;
  currency: string;
  startPeriod: string;
  endPeriod: string;
}

export interface CreateScenarioRequest {
  name: string;
  sourceBudgetId: string;
  sourceScenarioId: string;
}

export interface ShareBudgetRequest {
  userName: string;
}

export interface UpdateValueRequest {
  seriesId: string;
  period: string;
  value: number;
}

export interface UpdateValueResponse {
  updatedValues: Value[];
}

export interface UpdateFormulaRequest {
  formula: string;
  bindings: Array<{
    variableName: string;
    sourceSeriesId: string;
  }>;
}

export interface UpdateFormulaResponse {
  series: Series;
  formulaBindings: FormulaBinding[];
  updatedValues: Value[];
}

export interface RecalculateResponse {
  updatedValues: Value[];
}

export interface SeriesInput {
  key: string;
  name: string;
  type: SeriesType;
  formula?: string;
  unit?: string;
}

export interface CreateSeriesRequest extends SeriesInput {}

export interface UpdateSeriesRequest extends Partial<SeriesInput> {}

export interface MutateSeriesResponse {
  state: AppState;
  updatedValues: Value[];
}
