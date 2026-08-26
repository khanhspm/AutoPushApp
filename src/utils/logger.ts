import pino from 'pino';

import { env } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'LARK_APP_SECRET',
      'LARK_VERIFICATION_TOKEN',
      'LARK_ENCRYPT_KEY',
      'CMS_ADMIN_TOKEN',
      'CMS_AUTH_PEPPER',
      'SMTP_APP_PASSWORD',
      'MATCH_PASSWORD',
      'FIREBASE_CLI_TOKEN',
      'APP_STORE_CONNECT_API_KEY_ID',
      'APP_STORE_CONNECT_API_ISSUER_ID',
      'APP_STORE_CONNECT_API_KEY_PATH',
      'req.headers.authorization',
      'request.headers.authorization',
      'headers.authorization',
      '*.authorization',
      '*.Authorization',
      'req.headers.cookie',
      'request.headers.cookie',
      'headers.cookie',
      '*.cookie',
      '*.otp',
      '*.code',
      '*.token',
      '*.tokenHash',
      '*.resolvedSecrets',
      '*.childEnv',
    ],
    censor: '[REDACTED]',
  },
});
