import { describe, expect, it } from 'vitest';
import { threatAssessmentRules, triageQuestionName } from '../config.js';
import {
  buildTriageInput,
  triageInstructions,
  codexTriageInstructions,
  triageOutputSchema,
  getTriageProbability,
  parseCodexTriage,
} from '../providers/triage.js';

const result = (probability) => ({
  answers: [{ type: 'predicate', name: triageQuestionName, probability }],
});

describe('shared triage policy and predicate contract', () => {
  it('uses identical routing instructions and assessment input for Codex and Decisions', () => {
    expect(codexTriageInstructions).toContain(triageInstructions);
    const input = buildTriageInput('current alert', 'recent alert');
    expect(input).toContain(threatAssessmentRules);
    expect(input).toContain(
      'RECENT CONTEXT (previous messages):\nrecent alert',
    );
    expect(input).toContain('CURRENT MESSAGE TO EVALUATE:\ncurrent alert');
    expect(buildTriageInput('current alert', '')).toContain('(none)');
    expect(
      triageOutputSchema.properties.answers.items.properties.name.enum,
    ).toEqual([triageQuestionName]);
  });

  it.each([0, 0.49, 0.5, 0.8, 1])(
    'normalizes predicate probability %s from either provider',
    (probability) => {
      expect(getTriageProbability(result(probability))).toBe(probability);
      expect(parseCodexTriage(JSON.stringify(result(probability)))).toBe(
        probability,
      );
    },
  );

  it.each([
    undefined,
    null,
    {},
    { answers: [] },
    { answers: [null] },
    {
      answers: [
        { type: 'boolean', name: triageQuestionName, probability: 0.9 },
      ],
    },
    { answers: [{ type: 'predicate', name: 'wrong', probability: 0.9 }] },
    { answers: [...result(0.8).answers, ...result(0.4).answers] },
    ...[-0.1, 1.1, NaN, Infinity, '0.8', true, null].map(result),
  ])(
    'rejects missing, malformed, and out-of-range predicate answers',
    (response) => {
      expect(() => getTriageProbability(response)).toThrow('invalid predicate');
    },
  );

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    'true',
    JSON.stringify({ ...result(0.9), reasoning: 'not requested' }),
    JSON.stringify({
      answers: [{ ...result(0.9).answers[0], decision: true }],
    }),
  ])('rejects invalid Codex JSON or schema deviations', (content) => {
    expect(() => parseCodexTriage(content)).toThrow();
  });
});
