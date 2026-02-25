/**
 * Monte Carlo sprint simulation — probabilistic forecasting for sprints and backlogs.
 *
 * Unlike predictCompletion (single issue), this simulates ENTIRE sprints by
 * randomly sampling from historical cycle time distributions across many trials.
 * Produces probability curves: "80% chance of finishing 7 items in 14 days."
 *
 * Tools:
 *   - simulate_sprint: Run N-trial Monte Carlo simulation for a sprint
 *   - forecast_backlog: "When will we finish these N items?" with confidence intervals
 */

import {
  getOutcomes,
  getEvents,
  type Outcome,
  type PMEvent,
} from "./memory.js";

// ─── Types ──────────────────────────────────────────────

export interface SprintSimulationInput {
  /** Number of items to simulate completing (default: count of Ready+Active items) */
  itemCount?: number;
  /** Sprint duration in days (default: 14) */
  sprintDays?: number;
  /** Number of simulation trials (default: 10000) */
  trials?: number;
  /** Area filter — only use cycle times from this area */
  area?: string;
  /** WIP limit — max concurrent items (default: 1, per PM policy) */
  wipLimit?: number;
}

export interface SprintSimulationResult {
  input: {
    itemCount: number;
    sprintDays: number;
    trials: number;
    area: string | null;
    wipLimit: number;
  };
  /** How many items will likely be completed in the sprint */
  throughputForecast: {
    p10: number; // Pessimistic: 90% chance of completing at least this many
    p25: number;
    p50: number; // Median expectation
    p75: number;
    p90: number; // Optimistic: only 10% chance of completing this many or more
    mean: number;
    stdDev: number;
  };
  /** Probability of completing exactly N items */
  completionProbabilities: Array<{
    items: number;
    probability: number; // 0-1
    cumulativeProbability: number; // chance of completing AT LEAST this many
  }>;
  /** Can we finish all requested items? */
  targetAnalysis: {
    targetItems: number;
    probabilityOfCompletion: number; // 0-1
    confidenceLevel: "very_likely" | "likely" | "uncertain" | "unlikely" | "very_unlikely";
    recommendation: string;
  };
  /** Historical data quality */
  dataQuality: {
    sampleSize: number;
    cycleTimeRange: { min: number; max: number; median: number };
    area: string | null;
    confidence: "high" | "medium" | "low";
    warning: string | null;
  };
  /** Raw distribution for visualization */
  histogram: Array<{
    items: number;
    count: number;
    percentage: number;
  }>;
}

export interface BacklogForecastInput {
  /** Total items to forecast completing */
  itemCount: number;
  /** Number of simulation trials (default: 10000) */
  trials?: number;
  /** Area filter */
  area?: string;
  /** WIP limit (default: 1) */
  wipLimit?: number;
}

export interface BacklogForecastResult {
  input: {
    itemCount: number;
    trials: number;
    area: string | null;
    wipLimit: number;
  };
  /** When will we finish? */
  completionForecast: {
    p50Days: number; // Median: 50% chance of finishing by this day
    p80Days: number; // Likely: 80% chance
    p95Days: number; // Very likely: 95% chance
    p50Date: string; // ISO date
    p80Date: string;
    p95Date: string;
  };
  /** Sprint-by-sprint breakdown */
  sprintBreakdown: Array<{
    sprint: number;
    endDay: number;
    endDate: string;
    itemsCompleted: { p25: number; p50: number; p75: number };
    cumulativeCompleted: { p25: number; p50: number; p75: number };
    remainingItems: { p25: number; p50: number; p75: number };
    probabilityOfDone: number; // Probability all items done by this sprint
  }>;
  /** Risk analysis */
  riskAnalysis: {
    tailRiskDays: number; // P95 - P50 spread
    variabilityRatio: number; // StdDev / Mean
    riskLevel: "low" | "medium" | "high";
    factors: string[];
  };
  dataQuality: {
    sampleSize: number;
    confidence: "high" | "medium" | "low";
    warning: string | null;
  };
}

// ─── Core Simulation Engine ─────────────────────────────

/**
 * Extract cycle time samples from historical data.
 * Returns array of cycle times in days.
 */
async function getCycleTimeSamples(
  area?: string
): Promise<{ samples: number[]; warning: string | null }> {
  const [outcomes, events] = await Promise.all([
    getOutcomes(1000),
    getEvents(5000),
  ]);

  // Build cycle time map: issue → days from Active → Done
  const cycleTimes: number[] = [];

  for (const outcome of outcomes) {
    if (outcome.result !== "merged") continue;

    const issueEvents = events.filter(
      (e) => e.issue_number === outcome.issue_number
    );

    const activeEvent = issueEvents.find(
      (e) => e.event_type === "workflow_change" && e.to_value === "Active"
    );
    const doneEvent = issueEvents.find(
      (e) => e.event_type === "workflow_change" && e.to_value === "Done"
    );

    if (activeEvent && doneEvent) {
      const days =
        (new Date(doneEvent.timestamp).getTime() -
          new Date(activeEvent.timestamp).getTime()) /
        86400000;
      if (days > 0 && days < 90) {
        // Filter by area if specified
        if (area && outcome.area !== area) continue;
        cycleTimes.push(days);
      }
    }
  }

  // If area filter produced too few samples, fall back to all
  let warning: string | null = null;
  if (area && cycleTimes.length < 5) {
    warning = `Only ${cycleTimes.length} samples for area "${area}" — falling back to all areas`;
    // Re-run without area filter
    const allSamples = await getCycleTimeSamplesUnfiltered(outcomes, events);
    return { samples: allSamples, warning };
  }

  if (cycleTimes.length < 3) {
    warning =
      "Fewer than 3 historical cycle times — using synthetic distribution (3-7 days uniform)";
    // Generate synthetic samples
    const synthetic = Array.from({ length: 20 }, () => 3 + Math.random() * 4);
    return { samples: synthetic, warning };
  }

  return { samples: cycleTimes, warning };
}

function getCycleTimeSamplesUnfiltered(
  outcomes: Outcome[],
  events: PMEvent[]
): number[] {
  const cycleTimes: number[] = [];
  for (const outcome of outcomes) {
    if (outcome.result !== "merged") continue;
    const issueEvents = events.filter(
      (e) => e.issue_number === outcome.issue_number
    );
    const activeEvent = issueEvents.find(
      (e) => e.event_type === "workflow_change" && e.to_value === "Active"
    );
    const doneEvent = issueEvents.find(
      (e) => e.event_type === "workflow_change" && e.to_value === "Done"
    );
    if (activeEvent && doneEvent) {
      const days =
        (new Date(doneEvent.timestamp).getTime() -
          new Date(activeEvent.timestamp).getTime()) /
        86400000;
      if (days > 0 && days < 90) cycleTimes.push(days);
    }
  }
  return cycleTimes;
}

/**
 * Sample a random cycle time from the historical distribution.
 * Uses bootstrap sampling (random draw with replacement).
 */
function sampleCycleTime(samples: number[]): number {
  return samples[Math.floor(Math.random() * samples.length)];
}

/**
 * Run a single sprint trial: how many items complete in sprintDays?
 * Models WIP limit — items processed sequentially within WIP slots.
 */
function runSprintTrial(
  samples: number[],
  sprintDays: number,
  wipLimit: number
): number {
  let completed = 0;
  // Each WIP slot tracks remaining time on its current item
  const slots = new Array(wipLimit).fill(0);

  // Simulate day by day (0.25-day resolution for accuracy)
  const step = 0.25;
  for (let day = 0; day < sprintDays; day += step) {
    for (let s = 0; s < wipLimit; s++) {
      slots[s] -= step;
      if (slots[s] <= 0) {
        // Item completed (unless we just started)
        if (slots[s] < 0 || day > 0) {
          completed++;
        }
        // Start next item
        slots[s] = sampleCycleTime(samples);
      }
    }
  }

  return completed;
}

/**
 * Run a single backlog trial: how many days to complete N items?
 */
function runBacklogTrial(
  samples: number[],
  itemCount: number,
  wipLimit: number
): number {
  let completed = 0;
  let totalDays = 0;
  const slots = new Array(wipLimit).fill(0);

  // Initialize slots
  for (let s = 0; s < wipLimit && completed + s < itemCount; s++) {
    slots[s] = sampleCycleTime(samples);
  }

  const step = 0.25;
  const maxDays = 365; // Safety cap

  while (completed < itemCount && totalDays < maxDays) {
    totalDays += step;
    for (let s = 0; s < wipLimit; s++) {
      slots[s] -= step;
      if (slots[s] <= 0 && completed < itemCount) {
        completed++;
        if (completed < itemCount) {
          slots[s] = sampleCycleTime(samples);
        }
      }
    }
  }

  return Math.round(totalDays * 10) / 10;
}

// ─── Public Functions ───────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(sorted.length * p) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function mean(arr: number[]): number {
  return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;
}

function stdDev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

/**
 * Monte Carlo sprint simulation.
 *
 * Answers: "Given our historical velocity, how many items will we likely
 * complete in a sprint of N days?"
 */
export async function simulateSprint(
  input: SprintSimulationInput = {}
): Promise<SprintSimulationResult> {
  const sprintDays = input.sprintDays ?? 14;
  const trials = Math.min(input.trials ?? 10000, 50000); // Cap at 50k
  const wipLimit = input.wipLimit ?? 1;
  const area = input.area ?? null;
  const itemCount = input.itemCount ?? 10; // Target to evaluate against

  const { samples, warning } = await getCycleTimeSamples(area ?? undefined);

  // Run trials
  const results: number[] = [];
  for (let t = 0; t < trials; t++) {
    results.push(runSprintTrial(samples, sprintDays, wipLimit));
  }
  results.sort((a, b) => a - b);

  // Throughput forecast
  const throughputForecast = {
    p10: percentile(results, 0.1),
    p25: percentile(results, 0.25),
    p50: percentile(results, 0.5),
    p75: percentile(results, 0.75),
    p90: percentile(results, 0.9),
    mean: Math.round(mean(results) * 10) / 10,
    stdDev: Math.round(stdDev(results) * 10) / 10,
  };

  // Completion probabilities (histogram)
  const maxItems = Math.max(...results, itemCount);
  const histogram: SprintSimulationResult["histogram"] = [];
  const completionProbabilities: SprintSimulationResult["completionProbabilities"] = [];

  for (let n = 0; n <= maxItems; n++) {
    const count = results.filter((r) => r === n).length;
    const cumulativeCount = results.filter((r) => r >= n).length;
    histogram.push({
      items: n,
      count,
      percentage: Math.round((count / trials) * 1000) / 10,
    });
    completionProbabilities.push({
      items: n,
      probability: Math.round((count / trials) * 1000) / 1000,
      cumulativeProbability: Math.round((cumulativeCount / trials) * 1000) / 1000,
    });
  }

  // Target analysis
  const targetCompletions = results.filter((r) => r >= itemCount).length;
  const probabilityOfCompletion = targetCompletions / trials;

  const confidenceLevel: SprintSimulationResult["targetAnalysis"]["confidenceLevel"] =
    probabilityOfCompletion >= 0.9
      ? "very_likely"
      : probabilityOfCompletion >= 0.7
        ? "likely"
        : probabilityOfCompletion >= 0.4
          ? "uncertain"
          : probabilityOfCompletion >= 0.15
            ? "unlikely"
            : "very_unlikely";

  let recommendation: string;
  if (probabilityOfCompletion >= 0.9) {
    recommendation = `Very likely to complete all ${itemCount} items — comfortable sprint commitment`;
  } else if (probabilityOfCompletion >= 0.7) {
    recommendation = `Likely to complete ${itemCount} items — reasonable commitment with some risk`;
  } else if (probabilityOfCompletion >= 0.4) {
    recommendation = `Uncertain — consider committing to ${throughputForecast.p50} items (P50) and treating ${itemCount} as stretch`;
  } else if (probabilityOfCompletion >= 0.15) {
    recommendation = `Unlikely — ${itemCount} items is aggressive. Commit to ${throughputForecast.p25}-${throughputForecast.p50} items instead`;
  } else {
    recommendation = `Very unlikely — ${itemCount} items far exceeds capacity. Expected throughput is ${throughputForecast.p50} items (P50)`;
  }

  // Data quality
  const sortedSamples = [...samples].sort((a, b) => a - b);
  const dataQuality: SprintSimulationResult["dataQuality"] = {
    sampleSize: samples.length,
    cycleTimeRange: {
      min: Math.round(sortedSamples[0] * 10) / 10,
      max: Math.round(sortedSamples[sortedSamples.length - 1] * 10) / 10,
      median: Math.round(percentile(sortedSamples, 0.5) * 10) / 10,
    },
    area,
    confidence:
      samples.length >= 20 ? "high" : samples.length >= 10 ? "medium" : "low",
    warning,
  };

  return {
    input: { itemCount, sprintDays, trials, area, wipLimit },
    throughputForecast,
    completionProbabilities: completionProbabilities.filter(
      (cp) => cp.probability > 0 || cp.items <= itemCount
    ),
    targetAnalysis: {
      targetItems: itemCount,
      probabilityOfCompletion: Math.round(probabilityOfCompletion * 1000) / 1000,
      confidenceLevel,
      recommendation,
    },
    dataQuality,
    histogram: histogram.filter((h) => h.count > 0),
  };
}

/**
 * Monte Carlo backlog forecast.
 *
 * Answers: "When will we finish these N items?" with confidence intervals,
 * sprint-by-sprint breakdown, and risk analysis.
 */
export async function forecastBacklog(
  input: BacklogForecastInput
): Promise<BacklogForecastResult> {
  const { itemCount } = input;
  const trials = Math.min(input.trials ?? 10000, 50000);
  const wipLimit = input.wipLimit ?? 1;
  const area = input.area ?? null;

  const { samples, warning } = await getCycleTimeSamples(area ?? undefined);

  // Run trials — each returns total days to complete all items
  const dayResults: number[] = [];
  for (let t = 0; t < trials; t++) {
    dayResults.push(runBacklogTrial(samples, itemCount, wipLimit));
  }
  dayResults.sort((a, b) => a - b);

  const now = new Date();
  const addDays = (d: number) =>
    new Date(now.getTime() + d * 86400000).toISOString().split("T")[0];

  const p50Days = Math.round(percentile(dayResults, 0.5) * 10) / 10;
  const p80Days = Math.round(percentile(dayResults, 0.8) * 10) / 10;
  const p95Days = Math.round(percentile(dayResults, 0.95) * 10) / 10;

  // Sprint-by-sprint breakdown (14-day sprints)
  const sprintDuration = 14;
  const maxSprints = Math.ceil(p95Days / sprintDuration) + 2;
  const sprintBreakdown: BacklogForecastResult["sprintBreakdown"] = [];

  // For each sprint, run sub-simulation of throughput
  for (let sprint = 1; sprint <= Math.min(maxSprints, 12); sprint++) {
    const endDay = sprint * sprintDuration;
    const endDate = addDays(endDay);

    // Count how many trials completed all items by this sprint's end
    const doneByThisSprint = dayResults.filter((d) => d <= endDay).length;
    const probDone = doneByThisSprint / trials;

    // Estimate items completed by this sprint end
    // Use throughput per sprint from cycle time samples
    const sprintTrials: number[] = [];
    for (let t = 0; t < Math.min(trials, 2000); t++) {
      let completed = 0;
      let elapsed = 0;
      const slots = new Array(wipLimit).fill(0);
      for (let s = 0; s < wipLimit; s++) {
        slots[s] = sampleCycleTime(samples);
      }
      const step = 0.5;
      while (elapsed < endDay) {
        elapsed += step;
        for (let s = 0; s < wipLimit; s++) {
          slots[s] -= step;
          if (slots[s] <= 0) {
            completed++;
            slots[s] = sampleCycleTime(samples);
          }
        }
      }
      sprintTrials.push(Math.min(completed, itemCount));
    }
    sprintTrials.sort((a, b) => a - b);

    const cumP25 = percentile(sprintTrials, 0.25);
    const cumP50 = percentile(sprintTrials, 0.5);
    const cumP75 = percentile(sprintTrials, 0.75);

    sprintBreakdown.push({
      sprint,
      endDay,
      endDate,
      itemsCompleted: {
        p25: sprint === 1 ? cumP25 : Math.max(0, cumP25 - (sprintBreakdown[sprint - 2]?.cumulativeCompleted.p25 ?? 0)),
        p50: sprint === 1 ? cumP50 : Math.max(0, cumP50 - (sprintBreakdown[sprint - 2]?.cumulativeCompleted.p50 ?? 0)),
        p75: sprint === 1 ? cumP75 : Math.max(0, cumP75 - (sprintBreakdown[sprint - 2]?.cumulativeCompleted.p75 ?? 0)),
      },
      cumulativeCompleted: { p25: cumP25, p50: cumP50, p75: cumP75 },
      remainingItems: {
        p25: Math.max(0, itemCount - cumP25),
        p50: Math.max(0, itemCount - cumP50),
        p75: Math.max(0, itemCount - cumP75),
      },
      probabilityOfDone: Math.round(probDone * 1000) / 1000,
    });

    // Stop if P95 says we'd be done
    if (probDone >= 0.95) break;
  }

  // Risk analysis
  const tailRisk = Math.round((p95Days - p50Days) * 10) / 10;
  const meanDays = mean(dayResults);
  const sdDays = stdDev(dayResults);
  const variabilityRatio =
    meanDays > 0 ? Math.round((sdDays / meanDays) * 100) / 100 : 0;

  const factors: string[] = [];
  if (variabilityRatio > 0.5) {
    factors.push(
      "High variability in cycle times — estimates have wide confidence intervals"
    );
  }
  if (tailRisk > p50Days * 0.8) {
    factors.push(
      "Large tail risk — worst case is significantly worse than expected case"
    );
  }
  if (samples.length < 10) {
    factors.push("Limited historical data — predictions may be unreliable");
  }

  const sortedSamples = [...samples].sort((a, b) => a - b);
  const maxSample = sortedSamples[sortedSamples.length - 1];
  const minSample = sortedSamples[0];
  if (maxSample / minSample > 5) {
    factors.push(
      `Cycle times vary ${Math.round(maxSample / minSample)}x (${Math.round(minSample * 10) / 10}d to ${Math.round(maxSample * 10) / 10}d) — consider splitting by area`
    );
  }

  if (factors.length === 0) {
    factors.push("Cycle times are consistent — forecast is reliable");
  }

  const riskLevel: BacklogForecastResult["riskAnalysis"]["riskLevel"] =
    variabilityRatio > 0.5 || tailRisk > p50Days
      ? "high"
      : variabilityRatio > 0.3 || tailRisk > p50Days * 0.5
        ? "medium"
        : "low";

  return {
    input: { itemCount, trials, area, wipLimit },
    completionForecast: {
      p50Days,
      p80Days,
      p95Days,
      p50Date: addDays(p50Days),
      p80Date: addDays(p80Days),
      p95Date: addDays(p95Days),
    },
    sprintBreakdown,
    riskAnalysis: {
      tailRiskDays: tailRisk,
      variabilityRatio,
      riskLevel,
      factors,
    },
    dataQuality: {
      sampleSize: samples.length,
      confidence:
        samples.length >= 20 ? "high" : samples.length >= 10 ? "medium" : "low",
      warning,
    },
  };
}
