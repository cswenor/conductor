/**
 * Workflow Config Module Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  MVP_DEFAULTS,
  resolveWorkflowConfig,
  validateWorkflowConfigStrict,
  validateStepFields,
  parseWorkflowConfigJson,
  createWorkflowSnapshot,
  getResolvedWorkflowConfig,
  serializeWorkflowConfig,
  type WorkflowConfig,
  type ResolvedWorkflowConfig,
} from './index.ts';

// =============================================================================
// resolveWorkflowConfig
// =============================================================================

describe('resolveWorkflowConfig', () => {
  it('returns exact MVP_DEFAULTS when no args', () => {
    const result = resolveWorkflowConfig();
    expect(result).toEqual(MVP_DEFAULTS);
  });

  it('applies project partial override — only planner.model changes', () => {
    const result = resolveWorkflowConfig({ planner: { model: 'custom-model' } });
    expect(result.planner.model).toBe('custom-model');
    expect(result.planner.maxTokens).toBe(MVP_DEFAULTS.planner.maxTokens);
    expect(result.planner.temperature).toBe(MVP_DEFAULTS.planner.temperature);
    expect(result.reviewerPlan).toEqual(MVP_DEFAULTS.reviewerPlan);
    expect(result.implementer).toEqual(MVP_DEFAULTS.implementer);
    expect(result.reviewerCode).toEqual(MVP_DEFAULTS.reviewerCode);
  });

  it('overlay takes precedence over project config', () => {
    const result = resolveWorkflowConfig(
      { planner: { model: 'project-model' } },
      { planner: { model: 'overlay-model' } },
    );
    expect(result.planner.model).toBe('overlay-model');
  });

  it('merges budgets: project sets maxInputTokens, overlay sets maxDurationMs', () => {
    const result = resolveWorkflowConfig(
      { planner: { budgets: { maxInputTokens: 10000 } } },
      { planner: { budgets: { maxDurationMs: 5000 } } },
    );
    expect(result.planner.budgets.maxInputTokens).toBe(10000);
    expect(result.planner.budgets.maxDurationMs).toBe(5000);
  });

  it('sets implementer backend from project config', () => {
    const result = resolveWorkflowConfig({ implementer: { backend: 'agent_sdk' } });
    expect(result.implementer.backend).toBe('agent_sdk');
  });

  it('undefined fields in overlay do not overwrite project config values', () => {
    const result = resolveWorkflowConfig(
      { planner: { model: 'project-model', maxTokens: 4000 } },
      { planner: { model: undefined } },
    );
    expect(result.planner.model).toBe('project-model');
    expect(result.planner.maxTokens).toBe(4000);
  });

  it('is deterministic: same inputs produce identical output', () => {
    const proj: WorkflowConfig = { planner: { model: 'test', temperature: 0.5 } };
    const overlay: WorkflowConfig = { implementer: { backend: 'agent_sdk' } };
    const r1 = resolveWorkflowConfig(proj, overlay);
    const r2 = resolveWorkflowConfig(proj, overlay);
    expect(r1).toEqual(r2);
  });
});

// =============================================================================
// validateWorkflowConfigStrict
// =============================================================================

describe('validateWorkflowConfigStrict', () => {
  it('valid config returns empty errors', () => {
    const errors = validateWorkflowConfigStrict({
      planner: { model: 'test', maxTokens: 8192, temperature: 0.3 },
    });
    expect(errors).toEqual([]);
  });

  it('invalid field type (model: 123) reports error', () => {
    const errors = validateWorkflowConfigStrict({
      planner: { model: 123 },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('model'))).toBe(true);
  });

  it('unknown top-level step key (reviewer_plan) reports error', () => {
    const errors = validateWorkflowConfigStrict({
      reviewer_plan: { model: 'test' },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('reviewer_plan'))).toBe(true);
  });

  it('invalid backend enum reports error', () => {
    const errors = validateWorkflowConfigStrict({
      implementer: { backend: 'invalid' },
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some(e => e.includes('backend'))).toBe(true);
  });

  it('empty object is valid', () => {
    const errors = validateWorkflowConfigStrict({});
    expect(errors).toEqual([]);
  });

  it('unknown nested field within valid step is not an error (forward-compat)', () => {
    // NOTE: unknown nested fields accepted on write for forward-compat;
    // only unknown top-level step keys are rejected (typo protection)
    const errors = validateWorkflowConfigStrict({
      planner: { model: 'test', futureField: 'value' },
    });
    expect(errors).toEqual([]);
  });
});

// =============================================================================
// validateStepFields
// =============================================================================

describe('validateStepFields', () => {
  it('valid step fields return empty errors', () => {
    const errors = validateStepFields(
      { model: 'test', maxTokens: 4096, temperature: 0.5 },
      'planner',
    );
    expect(errors).toEqual([]);
  });

  it('invalid field type (model: 123) reports error', () => {
    const errors = validateStepFields({ model: 123 }, 'planner');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('model');
  });

  it('does not report unknown nested keys (sanitize job)', () => {
    const errors = validateStepFields(
      { model: 'test', unknownField: 42 },
      'planner',
    );
    expect(errors).toEqual([]);
  });
});

// =============================================================================
// parseWorkflowConfigJson
// =============================================================================

describe('parseWorkflowConfigJson', () => {
  it('null returns undefined', () => {
    expect(parseWorkflowConfigJson(null)).toBeUndefined();
  });

  it('undefined returns undefined', () => {
    expect(parseWorkflowConfigJson(undefined)).toBeUndefined();
  });

  it('valid JSON string returns parsed object', () => {
    const result = parseWorkflowConfigJson(
      JSON.stringify({ planner: { model: 'test' } }),
      'test',
    );
    expect(result).toEqual({ planner: { model: 'test' } });
  });

  it('invalid JSON string returns undefined and logs warning', () => {
    const result = parseWorkflowConfigJson('not json', 'test');
    expect(result).toBeUndefined();
  });

  it('valid JSON but not an object returns undefined', () => {
    const result = parseWorkflowConfigJson('"hello"', 'test');
    expect(result).toBeUndefined();
  });

  it('strips unknown top-level key, preserves known keys', () => {
    const result = parseWorkflowConfigJson(
      JSON.stringify({ futureStep: {}, planner: { model: 'custom' } }),
      'test',
    );
    expect(result).toEqual({ planner: { model: 'custom' } });
  });

  it('per-field salvage: bad maxTokens dropped, backend preserved', () => {
    const result = parseWorkflowConfigJson(
      JSON.stringify({ implementer: { backend: 'agent_sdk', maxTokens: 'bad' } }),
      'test',
    );
    expect(result).toBeDefined();
    expect(result?.implementer?.backend).toBe('agent_sdk');
    expect(result?.implementer?.maxTokens).toBeUndefined();
  });

  it('per-field salvage across steps: bad planner.model dropped, implementer preserved', () => {
    const result = parseWorkflowConfigJson(
      JSON.stringify({ planner: { model: 123 }, implementer: { model: 'custom' } }),
      'test',
    );
    expect(result).toBeDefined();
    expect(result?.planner).toBeUndefined();
    expect(result?.implementer?.model).toBe('custom');
  });

  it('all fields bad returns undefined with aggregate warning', () => {
    const result = parseWorkflowConfigJson(
      JSON.stringify({ planner: { model: 123 }, reviewerPlan: { maxTokens: 'bad' } }),
      'test',
    );
    expect(result).toBeUndefined();
  });
});

// =============================================================================
// sanitizeConfig / sanitizeStepConfig (tested via parseWorkflowConfigJson)
// =============================================================================

describe('sanitize via parseWorkflowConfigJson', () => {
  it('unknown top-level key is stripped', () => {
    const result = parseWorkflowConfigJson(
      JSON.stringify({ badStep: { model: 'x' }, planner: { model: 'y' } }),
      'sanitize-test',
    );
    expect(result).toEqual({ planner: { model: 'y' } });
  });

  it('unknown nested field is stripped', () => {
    const result = parseWorkflowConfigJson(
      JSON.stringify({ planner: { model: 'test', unknownField: 42 } }),
      'sanitize-test',
    );
    expect(result).toEqual({ planner: { model: 'test' } });
  });

  it('known fields preserved through sanitize', () => {
    const input = {
      planner: { model: 'test', maxTokens: 4096, temperature: 0.3 },
      implementer: { backend: 'agent_sdk', model: 'custom' },
    };
    const result = parseWorkflowConfigJson(JSON.stringify(input), 'sanitize-test');
    expect(result).toEqual(input);
  });
});

// =============================================================================
// createWorkflowSnapshot
// =============================================================================

describe('createWorkflowSnapshot', () => {
  it('no project config produces serialized MVP defaults', () => {
    const snapshot = createWorkflowSnapshot();
    const parsed = JSON.parse(snapshot) as ResolvedWorkflowConfig;
    expect(parsed).toEqual(MVP_DEFAULTS);
  });

  it('with project config merges into snapshot', () => {
    const snapshot = createWorkflowSnapshot(
      JSON.stringify({ planner: { model: 'custom-model' } }),
    );
    const parsed = JSON.parse(snapshot) as ResolvedWorkflowConfig;
    expect(parsed.planner.model).toBe('custom-model');
    expect(parsed.planner.maxTokens).toBe(MVP_DEFAULTS.planner.maxTokens);
  });

  it('implementerBackendFallback sets backend when not in project config', () => {
    const snapshot = createWorkflowSnapshot(null, 'agent_sdk');
    const parsed = JSON.parse(snapshot) as ResolvedWorkflowConfig;
    expect(parsed.implementer.backend).toBe('agent_sdk');
  });

  it('project config backend takes precedence over fallback', () => {
    const snapshot = createWorkflowSnapshot(
      JSON.stringify({ implementer: { backend: 'raw' } }),
      'agent_sdk',
    );
    const parsed = JSON.parse(snapshot) as ResolvedWorkflowConfig;
    expect(parsed.implementer.backend).toBe('raw');
  });
});

// =============================================================================
// getResolvedWorkflowConfig
// =============================================================================

describe('getResolvedWorkflowConfig', () => {
  it('run with no snapshot falls back to run.implementerBackend', () => {
    const result = getResolvedWorkflowConfig({
      implementerBackend: 'agent_sdk',
    });
    expect(result.implementer.backend).toBe('agent_sdk');
    expect(result.planner.model).toBe(MVP_DEFAULTS.planner.model);
  });

  it('run with snapshot uses snapshot values', () => {
    const snapshot = serializeWorkflowConfig({
      ...MVP_DEFAULTS,
      planner: { ...MVP_DEFAULTS.planner, model: 'snapshot-model' },
    });
    const result = getResolvedWorkflowConfig({
      workflowSnapshotJson: snapshot,
      implementerBackend: 'raw',
    });
    expect(result.planner.model).toBe('snapshot-model');
  });

  it('run with snapshot + overlay applies overlay on top', () => {
    const snapshot = serializeWorkflowConfig(MVP_DEFAULTS);
    const overlay: WorkflowConfig = { planner: { model: 'overlay-model' } };
    const result = getResolvedWorkflowConfig({
      workflowSnapshotJson: snapshot,
      workflowOverlayJson: JSON.stringify(overlay),
      implementerBackend: 'raw',
    });
    expect(result.planner.model).toBe('overlay-model');
  });

  it('legacy run (no snapshot, agent_sdk backend) resolves correctly', () => {
    const result = getResolvedWorkflowConfig({
      implementerBackend: 'agent_sdk',
    });
    expect(result.implementer.backend).toBe('agent_sdk');
    expect(result.planner).toEqual(MVP_DEFAULTS.planner);
  });
});

// =============================================================================
// warn-once dedupe (single test)
// =============================================================================

describe('warn-once dedupe', () => {
  it('sanitize same unknown field twice logs warning only once', async () => {
    // Mock the logger before re-importing the module
    const mockWarn = vi.fn();
    vi.resetModules();
    vi.doMock('../logger/index.ts', () => ({
      createLogger: () => ({ warn: mockWarn, info: vi.fn(), error: vi.fn() }),
    }));

    const mod = await import('./index.ts');

    const r1 = mod.parseWorkflowConfigJson(
      JSON.stringify({ planner: { unknownField: 42, model: 'test' } }),
      'dedupe-test',
    );
    const r2 = mod.parseWorkflowConfigJson(
      JSON.stringify({ planner: { unknownField: 99, model: 'test2' } }),
      'dedupe-test',
    );

    // Both should strip the unknown field and preserve model
    expect(r1).toEqual({ planner: { model: 'test' } });
    expect(r2).toEqual({ planner: { model: 'test2' } });

    // The warn for dedupe-test.planner.unknownField should have been called exactly once
    const dedupeWarns = mockWarn.mock.calls.filter(
      (call: unknown[]) => {
        const ctx = call[0] as Record<string, unknown>;
        return ctx.dedupeKey === 'dedupe-test.planner.unknownField';
      },
    );
    expect(dedupeWarns).toHaveLength(1);

    // Restore original modules for subsequent tests
    vi.doUnmock('../logger/index.ts');
    vi.resetModules();
  });
});

// =============================================================================
// MVP_DEFAULTS guards
// =============================================================================

describe('MVP_DEFAULTS guards', () => {
  it('implementer.maxTokens is 8192 (diverges from raw legacy 16384)', () => {
    // MVP_DEFAULTS.implementer.maxTokens does not match raw legacy (16384)
    // Runtime wiring PR must handle this divergence
    expect(MVP_DEFAULTS.implementer.maxTokens).toBe(8192);
  });
});
