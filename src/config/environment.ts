export interface Environment {
  PORT: number;
  DATABASE_URL: string;
  JWT_SECRET: string;
  JWT_TTL: string;
  REFRESH_TOKEN_TTL: string;
  CORS_ORIGIN: string;
}

export function validateEnvironment(raw: Record<string, unknown>): Environment {
  const databaseUrl = String(raw.DATABASE_URL ?? '');
  const jwtSecret = String(raw.JWT_SECRET ?? '');
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) throw new Error('DATABASE_URL must be a PostgreSQL connection string');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  const port = Number(raw.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port');
  return {
    PORT: port,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: jwtSecret,
    JWT_TTL: String(raw.JWT_TTL ?? '15m'),
    REFRESH_TOKEN_TTL: String(raw.REFRESH_TOKEN_TTL ?? '7d'),
    CORS_ORIGIN: String(raw.CORS_ORIGIN ?? 'http://localhost:5173'),
  };
}
