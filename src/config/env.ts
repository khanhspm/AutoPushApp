import os from 'node:os';
import path from 'node:path';

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const booleanString = z
  .string()
  .optional()
  .transform((value) => value === 'true');

const csvString = z
  .string()
  .optional()
  .transform((value) =>
    value
      ? value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : [],
  );

const trueByDefaultBooleanString = z
  .string()
  .default('true')
  .transform((value) => value === 'true');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z.string().default('info'),

    LARK_APP_ID: z.string().optional(),
    LARK_APP_SECRET: z.string().optional(),
    LARK_VERIFICATION_TOKEN: z.string().optional(),
    LARK_ENCRYPT_KEY: z.string().optional(),
    LARK_API_BASE_URL: z.string().url().default('https://open.larksuite.com'),

    CMS_ADMIN_TOKEN: z.string().min(16).default('dev-admin-token-change-me'),
    CMS_DEV_ORIGIN: z.string().url().default('http://localhost:5173'),
    CMS_PUBLIC_URL: z.string().url().default('http://localhost:5173'),
    CMS_AUTH_PEPPER: z.string().min(16).default('dev-cms-auth-pepper-change-me'),
    CMS_SESSION_COOKIE_NAME: z.string().trim().min(1).default('autopush_session'),
    SERVE_CMS: booleanString,
    CMS_DIST_PATH: z.string().default('./web/dist'),

    SMTP_HOST: z.string().trim().min(1).default('smtp.gmail.com'),
    SMTP_PORT: z.coerce.number().int().positive().default(465),
    SMTP_SECURE: trueByDefaultBooleanString,
    SMTP_USER: z.string().email().optional(),
    SMTP_APP_PASSWORD: z.string().min(1).optional(),
    SMTP_FROM: z.string().trim().min(1).optional(),

    REDIS_URL: z.string().url().default('redis://localhost:6379'),
    DB_PATH: z.string().default('./data/autopushapp.sqlite'),
    LOG_DIR: z.string().default('./logs/builds'),
    IOS_REPO_ROOTS: csvString,
    FASTLANE_RUNNER_PATH: z.string().default('./scripts/run_fastlane.sh'),
    BUILD_TIMEOUT_MS: z.coerce.number().int().positive().default(60 * 60 * 1000),
    RUNNER_ID: z.string().trim().min(1).default(os.hostname()),

    // Temporary compatibility while existing installations move configuration into the CMS.
    ALLOWED_USER_IDS: csvString,
    ALLOWED_PROJECT_IDS: csvString,
    IOS_PROJECT_PATH: z.string().optional(),
    FASTLANE_SCRIPT_PATH: z.string().optional(),
    START_WORKER_IN_PROCESS: booleanString,
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && value.CMS_ADMIN_TOKEN.length < 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CMS_ADMIN_TOKEN'],
        message: 'CMS_ADMIN_TOKEN must contain at least 32 characters in production',
      });
    }
    if (value.NODE_ENV === 'production' && value.CMS_AUTH_PEPPER.length < 32) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CMS_AUTH_PEPPER'],
        message: 'CMS_AUTH_PEPPER must contain at least 32 characters in production',
      });
    }
    if (value.NODE_ENV === 'production' && ['localhost', '127.0.0.1'].includes(new URL(value.CMS_PUBLIC_URL).hostname)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CMS_PUBLIC_URL'],
        message: 'CMS_PUBLIC_URL must use the deployed CMS hostname in production',
      });
    }
    if (value.NODE_ENV === 'production') {
      for (const field of ['SMTP_USER', 'SMTP_APP_PASSWORD', 'SMTP_FROM'] as const) {
        if (!value[field]) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [field],
            message: `${field} is required in production`,
          });
        }
      }
    }
  });

export type EnvSource = Record<string, string | undefined>;

export function loadEnv(source: EnvSource = process.env) {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }

  const data = parsed.data;

  return {
    ...data,
    DB_PATH: path.resolve(data.DB_PATH),
    LOG_DIR: path.resolve(data.LOG_DIR),
    CMS_DIST_PATH: path.resolve(data.CMS_DIST_PATH),
    FASTLANE_RUNNER_PATH: path.resolve(data.FASTLANE_RUNNER_PATH),
    IOS_REPO_ROOTS: data.IOS_REPO_ROOTS.map((root) => path.resolve(root)),
    IOS_PROJECT_PATH: data.IOS_PROJECT_PATH ? path.resolve(data.IOS_PROJECT_PATH) : undefined,
    FASTLANE_SCRIPT_PATH: data.FASTLANE_SCRIPT_PATH ? path.resolve(data.FASTLANE_SCRIPT_PATH) : undefined,
    SERVE_CMS: data.SERVE_CMS || data.NODE_ENV === 'production',
  };
}

export const env = loadEnv();

export type AppEnv = ReturnType<typeof loadEnv>;
