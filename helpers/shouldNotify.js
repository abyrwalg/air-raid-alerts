import isNowBetween from './isNowBetween.js';

// Decision only: no env loading, logging, HTTP, audio, or timers.
export function shouldNotify(analysis, now = new Date()) {
  if (!analysis?.relevant) {
    return false;
  }

  if (analysis.risk_level === 'high') {
    return true;
  }

  if (
    analysis.risk_level === 'medium' &&
    analysis.threat_type === 'cruise_missile'
  ) {
    return true;
  }

  if (analysis.risk_level === 'medium') {
    return isNowBetween('08:00', '22:00', now);
  }

  return false;
}
