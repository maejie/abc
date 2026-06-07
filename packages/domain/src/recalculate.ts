import { evaluateFormula } from "./formula.js";
import type { AppState, FormulaBinding, Series, Value } from "./types.js";

export function updateManualValue(state: AppState, seriesId: string, period: string, value: number): Value[] {
  const changed = upsertValue(state, {
    id: valueId(seriesId, period),
    seriesId,
    period,
    value,
    status: "manual",
  });
  return mergeChanged([changed], recalculateDownstream(state, [seriesId], [period]));
}

export function recalculateScenario(state: AppState): Value[] {
  return recalculateSeriesForPeriods(
    state,
    topologicalOrder(state.series, state.formulaBindings),
    state.periods,
  );
}

export function updateSeriesFormula(
  state: AppState,
  targetSeriesId: string,
  formula: string,
  bindings: Array<{ variableName: string; sourceSeriesId: string }>,
): Value[] {
  const series = state.series.find((item) => item.id === targetSeriesId);
  if (!series) throw new Error("Series not found");

  const previousFormula = series.formula;
  const previousBindings = state.formulaBindings.slice();
  series.formula = formula;
  state.formulaBindings = [
    ...state.formulaBindings.filter((binding) => binding.targetSeriesId !== targetSeriesId),
    ...bindings.map((binding) => ({
      id: `binding-${targetSeriesId}-${binding.variableName}`,
      targetSeriesId,
      variableName: binding.variableName,
      sourceSeriesId: binding.sourceSeriesId,
    })),
  ];

  try {
    assertNoCircularDependencies(state.series, state.formulaBindings);
  } catch (error) {
    series.formula = previousFormula;
    state.formulaBindings = previousBindings;
    throw error;
  }

  const affected = [targetSeriesId, ...downstreamSeriesIds(state.formulaBindings, [targetSeriesId])];
  return recalculateSeriesForPeriods(state, topologicalOrder(state.series, state.formulaBindings, affected), state.periods);
}

export function assertNoCircularDependencies(series: Series[], bindings: FormulaBinding[]): void {
  topologicalOrder(series, bindings);
}

function recalculateDownstream(state: AppState, sourceSeriesIds: string[], periods: string[]): Value[] {
  const affected = downstreamSeriesIds(state.formulaBindings, sourceSeriesIds);
  return recalculateSeriesForPeriods(state, topologicalOrder(state.series, state.formulaBindings, affected), periods);
}

function recalculateSeriesForPeriods(state: AppState, orderedSeriesIds: string[], periods: string[]): Value[] {
  const changed: Value[] = [];
  for (const seriesId of orderedSeriesIds) {
    const series = state.series.find((item) => item.id === seriesId);
    if (!series?.formula) continue;
    for (const period of periods) {
      changed.push(upsertValue(state, calculateValue(state, series, period)));
    }
  }
  return mergeChanged(changed);
}

function calculateValue(state: AppState, series: Series, period: string): Value {
  const bindings = state.formulaBindings.filter((binding) => binding.targetSeriesId === series.id);
  const variables: Record<string, number> = {};
  const formula = series.formula;

  try {
    if (!formula) throw new Error("Missing formula");
    const formulaForEvaluation = substituteAggregateFunctions(formula, state, series.id, period);
    for (const binding of bindings) {
      const sourceValue = state.values.find((value) => value.seriesId === binding.sourceSeriesId && value.period === period);
      if (!sourceValue || sourceValue.value === null || sourceValue.status === "error") {
        throw new Error(`Missing value for ${binding.variableName}`);
      }
      variables[binding.variableName] = sourceValue.value;
    }

    return {
      id: valueId(series.id, period),
      seriesId: series.id,
      period,
      value: evaluateFormula(formulaForEvaluation, variables),
      status: "ok",
    };
  } catch (error) {
    return {
      id: valueId(series.id, period),
      seriesId: series.id,
      period,
      value: null,
      status: "error",
      errorMessage: error instanceof Error ? error.message : "Formula evaluation failed",
    };
  }
}

function substituteAggregateFunctions(formula: string, state: AppState, targetSeriesId: string, period: string): string {
  return formula.replace(/Sum\s*\(\s*Type\s*=\s*(Income|Expense|Parameter|Calculated)\s*\)/gi, (_match, rawType: string) => {
    const type = rawType.toLowerCase() as Series["type"];
    const total = state.series
      .filter((series) => series.id !== targetSeriesId && series.type === type)
      .reduce((sum, series) => {
        const sourceValue = state.values.find((value) => value.seriesId === series.id && value.period === period);
        if (!sourceValue || sourceValue.value === null || sourceValue.status === "error") {
          throw new Error(`Missing value for ${series.key}`);
        }
        return sum + sourceValue.value;
      }, 0);
    return String(total);
  });
}

function upsertValue(state: AppState, next: Value): Value {
  const index = state.values.findIndex((value) => value.seriesId === next.seriesId && value.period === next.period);
  if (index === -1) {
    state.values.push(next);
  } else {
    state.values[index] = next;
  }
  return next;
}

export function downstreamSeriesIds(bindings: FormulaBinding[], sourceSeriesIds: string[]): string[] {
  const result: string[] = [];
  const queue = [...sourceSeriesIds];
  const seen = new Set(sourceSeriesIds);

  while (queue.length > 0) {
    const sourceId = queue.shift()!;
    const targets = bindings.filter((binding) => binding.sourceSeriesId === sourceId).map((binding) => binding.targetSeriesId);
    for (const targetId of targets) {
      if (seen.has(targetId)) continue;
      seen.add(targetId);
      result.push(targetId);
      queue.push(targetId);
    }
  }

  return result;
}

function topologicalOrder(series: Series[], bindings: FormulaBinding[], subset?: string[]): string[] {
  const subsetSet = subset ? new Set(subset) : undefined;
  const ids = series.map((item) => item.id);
  const indegree = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map<string, string[]>();

  for (const binding of bindings) {
    outgoing.set(binding.sourceSeriesId, [...(outgoing.get(binding.sourceSeriesId) ?? []), binding.targetSeriesId]);
    indegree.set(binding.targetSeriesId, (indegree.get(binding.targetSeriesId) ?? 0) + 1);
  }

  const queue = ids.filter((id) => (indegree.get(id) ?? 0) === 0);
  const ordered: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const targetId of outgoing.get(id) ?? []) {
      indegree.set(targetId, (indegree.get(targetId) ?? 0) - 1);
      if (indegree.get(targetId) === 0) queue.push(targetId);
    }
  }

  if (ordered.length !== ids.length) {
    throw new Error("Circular formula dependency detected");
  }

  return subsetSet ? ordered.filter((id) => subsetSet.has(id)) : ordered;
}

function mergeChanged(values: Value[], additional: Value[] = []): Value[] {
  const merged = new Map<string, Value>();
  for (const value of [...values, ...additional]) {
    merged.set(`${value.seriesId}:${value.period}`, value);
  }
  return [...merged.values()];
}

export function valueId(seriesId: string, period: string): string {
  return `value-${seriesId}-${period}`;
}
