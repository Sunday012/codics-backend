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

export function validateStorageConfig(
  config: Record<string, unknown>,
  nodeEnv: string | undefined,
): void {
  if (nodeEnv === 'test') {
    return;
  }

  const rawDriver = String(
    config.STORAGE_DRIVER ?? (nodeEnv === 'production' ? 's3' : 'disk'),
  )
    .trim()
    .toLowerCase();

  if (!['disk', 'local', 's3', 'r2'].includes(rawDriver)) {
    throw new Error(
      `Invalid STORAGE_DRIVER "${rawDriver}". Allowed values are "disk" or "s3".`,
    );
  }

  if (
    nodeEnv === 'production' &&
    (rawDriver === 'disk' || rawDriver === 'local') &&
    String(config.ALLOW_LOCAL_DISK_IN_PROD) !== 'true'
  ) {
    throw new Error(
      'Production environment requires persistent S3-compatible object storage (STORAGE_DRIVER=s3).',
    );
  }

  if (rawDriver === 's3' || rawDriver === 'r2') {
    const endpoint = String(config.STORAGE_ENDPOINT ?? '').trim();
    const bucket = String(config.STORAGE_BUCKET ?? '').trim();
    const accessKeyId = String(config.STORAGE_ACCESS_KEY_ID ?? '').trim();
    const secretAccessKey = String(
      config.STORAGE_SECRET_ACCESS_KEY ?? '',
    ).trim();

    if (
      !endpoint ||
      /<account-id>|replace|change-me|example\.com/i.test(endpoint)
    ) {
      throw new Error(
        'STORAGE_ENDPOINT is missing or contains a placeholder value. A valid S3/R2 endpoint URL is required when STORAGE_DRIVER=s3.',
      );
    }

    try {
      const parsed = new URL(endpoint);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error('Invalid protocol');
      }
    } catch {
      throw new Error(
        'STORAGE_ENDPOINT must be a valid HTTP/HTTPS URL when STORAGE_DRIVER=s3.',
      );
    }

    if (!bucket || /replace|change-me|example/i.test(bucket)) {
      throw new Error(
        'STORAGE_BUCKET is missing or contains a placeholder value when STORAGE_DRIVER=s3.',
      );
    }

    if (!accessKeyId || /replace|change-me|example/i.test(accessKeyId)) {
      throw new Error(
        'STORAGE_ACCESS_KEY_ID is missing or contains a placeholder value when STORAGE_DRIVER=s3.',
      );
    }

    if (!secretAccessKey || /replace|change-me|example/i.test(secretAccessKey)) {
      throw new Error(
        'STORAGE_SECRET_ACCESS_KEY is missing or contains a placeholder value when STORAGE_DRIVER=s3.',
      );
    }
  }
}

export function validateEmailAndPushConfig(
  config: Record<string, unknown>,
  nodeEnv: string | undefined,
): void {
  if (nodeEnv === 'test') {
    return;
  }

  const provider = String(config.EMAIL_PROVIDER ?? 'console')
    .trim()
    .toLowerCase();

  if (
    !['console', 'mock', 'resend', 'postmark', 'sendgrid', 'http'].includes(
      provider,
    )
  ) {
    throw new Error(
      `Invalid EMAIL_PROVIDER "${provider}". Allowed values are "console", "resend", "postmark", "sendgrid", or "http".`,
    );
  }

  if (['resend', 'postmark', 'sendgrid', 'http'].includes(provider)) {
    const apiKey = String(config.EMAIL_API_KEY ?? '').trim();
    const fromAddress = String(config.EMAIL_FROM_ADDRESS ?? '').trim();

    if (!apiKey || /replace|change-me|example/i.test(apiKey)) {
      throw new Error(
        `EMAIL_API_KEY is missing or contains a placeholder value when EMAIL_PROVIDER=${provider}.`,
      );
    }

    if (!fromAddress || !fromAddress.includes('@')) {
      throw new Error(
        `EMAIL_FROM_ADDRESS must be a valid verified sender email when EMAIL_PROVIDER=${provider}.`,
      );
    }
  }

  const pushEnabled =
    String(config.WEB_PUSH_ENABLED ?? 'false')
      .trim()
      .toLowerCase() === 'true';

  if (pushEnabled) {
    const pubKey = String(config.VAPID_PUBLIC_KEY ?? '').trim();
    const privKey = String(config.VAPID_PRIVATE_KEY ?? '').trim();
    const subject = String(config.VAPID_SUBJECT ?? '').trim();

    if (!pubKey || /replace|change-me|example/i.test(pubKey)) {
      throw new Error(
        'VAPID_PUBLIC_KEY is missing or contains a placeholder value when WEB_PUSH_ENABLED=true.',
      );
    }
    if (!privKey || /replace|change-me|example/i.test(privKey)) {
      throw new Error(
        'VAPID_PRIVATE_KEY is missing or contains a placeholder value when WEB_PUSH_ENABLED=true.',
      );
    }
    if (
      !subject ||
      (!subject.startsWith('mailto:') && !subject.startsWith('https://'))
    ) {
      throw new Error(
        'VAPID_SUBJECT must start with "mailto:" or "https://" when WEB_PUSH_ENABLED=true.',
      );
    }
  }
}

export function validateEnvironment(config: Record<string, unknown>) {
  const nodeEnv = config.NODE_ENV as string | undefined;
  const jwtSecret = config.JWT_SECRET as string | undefined;
  validateJwtSecret(jwtSecret, nodeEnv);
  validateStorageConfig(config, nodeEnv);
  validateEmailAndPushConfig(config, nodeEnv);
  return config;
}
