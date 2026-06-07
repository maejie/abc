import { assertNoCircularDependencies, downstreamSeriesIds, recalculateScenario, valueId } from "./recalculate.js";
import type { AppState, FormulaBinding, Series, SeriesInput, Value } from "./types.js";

export function createSeries(state: AppState, input: SeriesInput): { series: Series; updatedValues: Value[] } {
  const normalized = normalizeSeriesInput(input);
  validateSeriesInput(state, normalized);

  const series: Series = {
    id: newSeriesId(normalized.key),
    scenarioId: state.scenario.id,
    key: normalized.key,
    name: normalized.name,
    type: normalized.type,
    formula: normalized.formula || undefined,
    unit: normalized.unit || undefined,
  };

  state.series.push(series);
  state.values.push(...initialValuesForSeries(series, state.periods));
  try {
    refreshFormulaBindings(state);
    const updatedValues = recalculateScenario(state);
    return { series, updatedValues };
  } catch (error) {
    state.series = state.series.filter((item) => item.id !== series.id);
    state.values = state.values.filter((value) => value.seriesId !== series.id);
    state.formulaBindings = state.formulaBindings.filter((binding) => binding.targetSeriesId !== series.id);
    throw error;
  }
}

export function updateSeriesDetails(
  state: AppState,
  seriesId: string,
  input: Partial<SeriesInput>,
): { series: Series; updatedValues: Value[] } {
  const series = state.series.find((item) => item.id === seriesId);
  if (!series) throw new Error("Series not found");

  const next: SeriesInput = normalizeSeriesInput({
    key: input.key ?? series.key,
    name: input.name ?? series.name,
    type: input.type ?? series.type,
    formula: input.formula ?? series.formula,
    unit: input.unit ?? series.unit,
  });
  validateSeriesInput(state, next, seriesId);

  const snapshot = {
    ...series,
    bindings: state.formulaBindings.slice(),
  };

  series.key = next.key;
  series.name = next.name;
  series.type = next.type;
  series.unit = next.unit || undefined;

  try {
    series.formula = next.formula || undefined;
    refreshFormulaBindings(state);
    const updatedValues = recalculateScenario(state);
    return { series, updatedValues };
  } catch (error) {
    series.key = snapshot.key;
    series.name = snapshot.name;
    series.type = snapshot.type;
    series.formula = snapshot.formula;
    series.unit = snapshot.unit;
    state.formulaBindings = snapshot.bindings;
    throw error;
  }
}

export function deleteSeries(state: AppState, seriesId: string): { updatedValues: Value[] } {
  const series = state.series.find((item) => item.id === seriesId);
  if (!series) throw new Error("Series not found");

  const affectedSeriesIds = downstreamSeriesIds(state.formulaBindings, [seriesId]);
  state.series = state.series.filter((item) => item.id !== seriesId);
  state.values = state.values.filter((value) => value.seriesId !== seriesId);
  state.formulaBindings = state.formulaBindings.filter(
    (binding) => binding.targetSeriesId !== seriesId && binding.sourceSeriesId !== seriesId,
  );

  refreshFormulaBindings(state);
  const recalculated = recalculateScenario(state);
  return {
    updatedValues: recalculated.filter((value) => affectedSeriesIds.includes(value.seriesId)),
  };
}

export function bindingsFromFormula(
  state: AppState,
  targetSeriesId: string,
  formula: string,
): Array<{ variableName: string; sourceSeriesId: string }> {
  const aggregateBindings = bindingsFromAggregateFunctions(state, targetSeriesId, formula);
  const variableNames = extractVariableNames(stripAggregateFunctions(formula));
  const variableBindings = variableNames.map((variableName) => {
    const source = state.series.find((series) => series.key === variableName && series.id !== targetSeriesId);
    if (!source) throw new Error(`Formula variable "${variableName}" does not match another series key`);
    return { variableName, sourceSeriesId: source.id };
  });
  return dedupeBindings([...variableBindings, ...aggregateBindings]);
}

export function refreshFormulaBindings(state: AppState): void {
  const bindings: FormulaBinding[] = [];
  for (const series of state.series) {
    if (!series.formula) continue;
    for (const binding of bindingsFromFormula(state, series.id, series.formula)) {
      bindings.push({
        id: `binding-${series.id}-${binding.variableName}`,
        targetSeriesId: series.id,
        variableName: binding.variableName,
        sourceSeriesId: binding.sourceSeriesId,
      });
    }
  }
  assertNoCircularDependencies(state.series, bindings);
  state.formulaBindings = bindings;
}

function normalizeSeriesInput(input: SeriesInput): SeriesInput {
  return {
    key: input.key.trim(),
    name: input.name.trim(),
    type: input.type,
    formula: input.formula?.trim() || undefined,
    unit: input.unit?.trim() || undefined,
  };
}

function validateSeriesInput(state: AppState, input: SeriesInput, currentSeriesId?: string): void {
  if (!input.name) throw new Error("Series name is required");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.key)) {
    throw new Error("Series key must start with a letter or underscore and contain only letters, numbers, and underscores");
  }
  if (!["income", "expense", "parameter", "calculated"].includes(input.type)) {
    throw new Error("Invalid series type");
  }
  const duplicate = state.series.find((series) => series.key === input.key && series.id !== currentSeriesId);
  if (duplicate) throw new Error("Series key must be unique");
}

function extractVariableNames(formula: string): string[] {
  const names = new Set<string>();
  for (const match of formula.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    names.add(match[0]);
  }
  return [...names];
}

function stripAggregateFunctions(formula: string): string {
  return formula.replace(/Sum\s*\(\s*Type\s*=\s*(Income|Expense|Parameter|Calculated)\s*\)/gi, "0");
}

function bindingsFromAggregateFunctions(
  state: AppState,
  targetSeriesId: string,
  formula: string,
): Array<{ variableName: string; sourceSeriesId: string }> {
  const bindings: Array<{ variableName: string; sourceSeriesId: string }> = [];
  const seenTypes = new Set<Series["type"]>();
  for (const match of formula.matchAll(/Sum\s*\(\s*Type\s*=\s*(Income|Expense|Parameter|Calculated)\s*\)/gi)) {
    seenTypes.add(match[1].toLowerCase() as Series["type"]);
  }

  for (const type of seenTypes) {
    for (const series of state.series) {
      if (series.id === targetSeriesId || series.type !== type) continue;
      bindings.push({
        variableName: `__sum_${type}_${series.key}`,
        sourceSeriesId: series.id,
      });
    }
  }

  return bindings;
}

function dedupeBindings(
  bindings: Array<{ variableName: string; sourceSeriesId: string }>,
): Array<{ variableName: string; sourceSeriesId: string }> {
  const bySource = new Map<string, { variableName: string; sourceSeriesId: string }>();
  for (const binding of bindings) {
    bySource.set(binding.sourceSeriesId, binding);
  }
  return [...bySource.values()];
}

function initialValuesForSeries(series: Series, periods: string[]): Value[] {
  return periods.map((period) => ({
    id: valueId(series.id, period),
    seriesId: series.id,
    period,
    value: series.formula ? null : 0,
    status: series.formula ? "ok" : "manual",
  }));
}

function newSeriesId(key: string): string {
  return `series-${key.replaceAll("_", "-")}-${Date.now().toString(36)}`;
}
