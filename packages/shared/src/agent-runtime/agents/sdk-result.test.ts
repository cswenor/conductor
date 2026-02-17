/**
 * extractTerminalAssistantText Tests
 */

import { describe, it, expect } from 'vitest';
import { extractTerminalAssistantText } from './sdk-result.ts';
import { AgentError } from '../provider.ts';

describe('extractTerminalAssistantText', () => {
  it('extracts text from end_turn message with text-only content', () => {
    const result = extractTerminalAssistantText(
      {
        content: [{ type: 'text', text: 'Here is the plan' }],
        stopReason: 'end_turn',
      },
      'Planner',
    );
    expect(result).toBe('Here is the plan');
  });

  it('joins multiple text blocks with newline', () => {
    const result = extractTerminalAssistantText(
      {
        content: [
          { type: 'text', text: 'Part 1' },
          { type: 'text', text: 'Part 2' },
        ],
        stopReason: 'end_turn',
      },
      'Planner',
    );
    expect(result).toBe('Part 1\nPart 2');
  });

  it('trims whitespace from result', () => {
    const result = extractTerminalAssistantText(
      {
        content: [{ type: 'text', text: '  trimmed  ' }],
        stopReason: 'end_turn',
      },
      'Test',
    );
    expect(result).toBe('trimmed');
  });

  it('throws no_output for undefined snapshot', () => {
    expect(() => extractTerminalAssistantText(undefined, 'Planner'))
      .toThrow(AgentError);
    try {
      extractTerminalAssistantText(undefined, 'Planner');
    } catch (e) {
      expect((e as AgentError).code).toBe('no_output');
      expect((e as AgentError).message).toContain('Planner');
    }
  });

  it('throws output_truncated for stop_reason max_tokens', () => {
    try {
      extractTerminalAssistantText(
        { content: [{ type: 'text', text: 'partial' }], stopReason: 'max_tokens' },
        'Planner',
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as AgentError).code).toBe('output_truncated');
    }
  });

  it('throws unexpected_stop for stop_reason tool_use', () => {
    try {
      extractTerminalAssistantText(
        { content: [{ type: 'text', text: 'partial' }], stopReason: 'tool_use' },
        'Reviewer',
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as AgentError).code).toBe('unexpected_stop');
    }
  });

  it('throws unexpected_stop for undefined stop_reason', () => {
    try {
      extractTerminalAssistantText(
        { content: [{ type: 'text', text: 'partial' }], stopReason: undefined },
        'Reviewer',
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as AgentError).code).toBe('unexpected_stop');
    }
  });

  it('throws tool_use_terminal when content contains tool_use blocks', () => {
    try {
      extractTerminalAssistantText(
        {
          content: [
            { type: 'text', text: 'some text' },
            { type: 'tool_use', id: 'tu_1', name: 'read_file', input: {} },
          ],
          stopReason: 'end_turn',
        },
        'Planner',
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as AgentError).code).toBe('tool_use_terminal');
    }
  });

  it('throws no_output for empty text blocks', () => {
    try {
      extractTerminalAssistantText(
        { content: [{ type: 'text', text: '' }], stopReason: 'end_turn' },
        'Planner',
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as AgentError).code).toBe('no_output');
    }
  });

  it('throws no_output for whitespace-only text blocks', () => {
    try {
      extractTerminalAssistantText(
        { content: [{ type: 'text', text: '   \n  ' }], stopReason: 'end_turn' },
        'Planner',
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as AgentError).code).toBe('no_output');
    }
  });

  it('throws no_output for content with no text blocks', () => {
    try {
      extractTerminalAssistantText(
        { content: [{ type: 'thinking', text: 'internal' }], stopReason: 'end_turn' },
        'Reviewer',
      );
      expect.fail('should have thrown');
    } catch (e) {
      expect((e as AgentError).code).toBe('no_output');
    }
  });

  it('includes agent label in error messages', () => {
    try {
      extractTerminalAssistantText(undefined, 'MyAgent');
    } catch (e) {
      expect((e as AgentError).message).toContain('MyAgent');
    }
  });
});
