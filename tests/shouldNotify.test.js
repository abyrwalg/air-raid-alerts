import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { shouldNotify } from '../notify.js';

describe('shouldTriggerWebhook', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false when not relevant', () => {
    expect(shouldNotify({ relevant: false })).toBe(false);
  });

  it('returns true for high risk', () => {
    expect(shouldNotify({ relevant: true, risk_level: 'high' })).toBe(true);
  });

  it('returns true for medium risk inside allowed time', () => {
    vi.setSystemTime(new Date('2025-02-01T09:00:00')); // 09:00 → inside 08:00–22:00

    expect(shouldNotify({ relevant: true, risk_level: 'medium' })).toBe(true);
  });

  it('returns false for medium risk outside allowed time', () => {
    vi.setSystemTime(new Date('2025-02-01T23:30:00')); // outside 22:00

    expect(shouldNotify({ relevant: true, risk_level: 'medium' })).toBe(false);
  });

  /*   it('returns true for medium risk outside allowed time if threat is cruise missile', () => {
    vi.setSystemTime(new Date('2025-02-01T23:30:00')); // outside 22:00

    expect(
      shouldNotify({
        relevant: true,
        risk_level: 'medium',
        threat_type: 'cruise_missile',
      })
    ).toBe(true);
  }); */
});
