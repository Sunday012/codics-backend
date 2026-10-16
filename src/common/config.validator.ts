export function validateJwtSecret(
  secret: string | undefined,
  nodeEnv: string | undefined,
): void {
  if (nodeEnv === 'test') {
    return;
  }
  if (!secret) {
    throw new Error(
      'JWT_SECRET is missing. A secure random JWT_SECRET of at least 32 characters is required outside test environments.',
    );
  }
  if (secret.length < 32) {
    throw new Error(
      `JWT_SECRET is too short (${secret.length} chars). It must be at least 32 characters long.`,
    );
  }
  if (/replace|change-me|example/i.test(secret)) {
    throw new Error(
      'JWT_SECRET cannot be a placeholder or default value (e.g. contains replace, change-me, example).',
    );
  }
}

export function validateEnvironment(config: Record<string, unknown>) {
  const nodeEnv = config.NODE_ENV as string | undefined;
  const jwtSecret = config.JWT_SECRET as string | undefined;
  validateJwtSecret(jwtSecret, nodeEnv);
  return config;
}
