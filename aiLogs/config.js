import path from 'node:path';

export function getLogConfig(env = process.env) {
  const rawEnabled = env.AI_LOGS_ENABLED?.trim().toLowerCase();
  if (rawEnabled && rawEnabled !== 'true' && rawEnabled !== 'false') {
    throw new Error('AI_LOGS_ENABLED must be true or false.');
  }
  const rawDays = env.AI_LOG_RETENTION_DAYS?.trim();
  const retentionDays = rawDays ? Number(rawDays) : 30;
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3650
  ) {
    throw new Error(
      'AI_LOG_RETENTION_DAYS must be an integer between 1 and 3650.',
    );
  }
  return {
    enabled: rawEnabled !== 'false',
    retentionDays,
    filePath: path.resolve(
      env.AI_LOGS_PATH?.trim() || path.join('logs', 'ai.json'),
    ),
  };
}
