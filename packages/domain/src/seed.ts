import { listPeriods } from "./periods.js";
import { recalculateScenario, valueId } from "./recalculate.js";
import { refreshFormulaBindings } from "./series.js";
import type { AppState, Budget, Series, Value } from "./types.js";

type SeedOptions = {
  budget: Budget;
  scenarioId: string;
  scenarioName: string;
  seriesSuffix?: string;
  users?: number[];
  cloudCost?: number[];
};

export function createSeedStates(): AppState[] {
  const mvpBudget = {
    id: "budget-mvp",
    name: "MVP Budget",
    currency: "JPY",
    startPeriod: "2026-01",
    endPeriod: "2026-06",
    ownerUserId: "alice",
  };
  const growthBudget = {
    id: "budget-growth",
    name: "Growth Budget",
    currency: "JPY",
    startPeriod: "2026-01",
    endPeriod: "2026-06",
    ownerUserId: "alice",
  };

  return [
    createSeedState({ budget: mvpBudget, scenarioId: "scenario-base", scenarioName: "Base Case" }),
    createSeedState({
      budget: mvpBudget,
      scenarioId: "scenario-upside",
      scenarioName: "Upside Case",
      seriesSuffix: "upside",
      users: [120, 150, 180, 210, 240, 270],
      cloudCost: [90000, 100000, 115000, 130000, 145000, 160000],
    }),
    createSeedState({
      budget: growthBudget,
      scenarioId: "scenario-growth-base",
      scenarioName: "Base Case",
      seriesSuffix: "growth",
      users: [80, 95, 115, 135, 160, 190],
      cloudCost: [70000, 80000, 90000, 100000, 115000, 130000],
    }),
  ];
}

export function createSeedState(options?: SeedOptions): AppState {
  const budget = options?.budget ?? {
    id: "budget-mvp",
    name: "MVP Budget",
    currency: "JPY",
    startPeriod: "2026-01",
    endPeriod: "2026-06",
    ownerUserId: "alice",
  };
  const scenario = { id: options?.scenarioId ?? "scenario-base", budgetId: budget.id, name: options?.scenarioName ?? "Base Case" };
  const periods = listPeriods(budget.startPeriod, budget.endPeriod);
  const suffix = options?.seriesSuffix ? `-${options.seriesSuffix}` : "";
  const seriesId = (key: string) => `series-${key}${suffix}`;

  const series: Series[] = [
    { id: seriesId("revenue"), scenarioId: scenario.id, key: "revenue", name: "Revenue", type: "income", formula: "users * unitPrice" },
    { id: seriesId("users"), scenarioId: scenario.id, key: "users", name: "Users", type: "parameter", unit: "users" },
    { id: seriesId("unit-price"), scenarioId: scenario.id, key: "unitPrice", name: "Unit Price", type: "parameter", unit: "JPY/user" },
    { id: seriesId("engineer-cost"), scenarioId: scenario.id, key: "engineerCost", name: "Engineer Cost", type: "expense", formula: "headcount * unitCost" },
    { id: seriesId("headcount"), scenarioId: scenario.id, key: "headcount", name: "Headcount", type: "parameter", unit: "people" },
    { id: seriesId("unit-cost"), scenarioId: scenario.id, key: "unitCost", name: "Unit Cost", type: "parameter", unit: "JPY/person" },
    { id: seriesId("cloud-cost"), scenarioId: scenario.id, key: "cloudCost", name: "Cloud Cost", type: "expense" },
    { id: seriesId("income-subtotal"), scenarioId: scenario.id, key: "income_subtotal", name: "Income Subtotal", type: "calculated", formula: "Sum(Type=Income)" },
    { id: seriesId("expense-subtotal"), scenarioId: scenario.id, key: "expense_subtotal", name: "Expense Subtotal", type: "calculated", formula: "Sum(Type=Expense)" },
    { id: seriesId("total"), scenarioId: scenario.id, key: "total", name: "Total", type: "calculated", formula: "income_subtotal - expense_subtotal" },
  ];

  const values: Value[] = [
    ...monthlyValues(seriesId("users"), periods, options?.users ?? [100, 120, 140, 160, 180, 200]),
    ...monthlyValues(seriesId("unit-price"), periods, [10000, 10000, 10000, 10000, 10000, 10000]),
    ...monthlyValues(seriesId("headcount"), periods, [5, 5, 6, 6, 7, 7]),
    ...monthlyValues(seriesId("unit-cost"), periods, [100000, 100000, 100000, 100000, 100000, 100000]),
    ...monthlyValues(seriesId("cloud-cost"), periods, options?.cloudCost ?? [80000, 90000, 100000, 110000, 120000, 130000]),
  ];

  const state = { budget, scenario, periods, series, values, formulaBindings: [] };
  refreshFormulaBindings(state);
  recalculateScenario(state);
  return state;
}

function monthlyValues(seriesId: string, periods: string[], values: number[]): Value[] {
  return periods.map((period, index) => ({
    id: valueId(seriesId, period),
    seriesId,
    period,
    value: values[index],
    status: "manual",
  }));
}
