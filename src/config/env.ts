/**
 * Environment Configuration
 * Validates and exports environment variables using Zod
 */

import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // Authentication
  API_KEY: z.string().min(1, 'API_KEY is required'),

  // Database
  DATABASE_URL: z.string().url().optional(),

  // Mercado Livre
  ML_CLIENT_ID: z.string().min(1, 'ML_CLIENT_ID is required'),
  ML_CLIENT_SECRET: z.string().min(1, 'ML_CLIENT_SECRET is required'),
  ML_REDIRECT_URI: z.string().url().default('http://localhost:3000/callback'),

  // Mercado Pago
  MP_CLIENT_ID: z.string().min(1, 'MP_CLIENT_ID is required'),
  MP_CLIENT_SECRET: z.string().min(1, 'MP_CLIENT_SECRET is required'),
  MP_ACCESS_TOKEN: z.string().optional(),

  // Sync Settings
  SYNC_DAYS_BACK: z.coerce.number().default(30),
  SYNC_CRON: z.string().default('0 */6 * * *'),

  // Alerts
  ALERT_EMAIL: z.string().email().optional(),
  ALERT_WEBHOOK_URL: z.string().url().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('❌ Invalid environment variables:');
  // eslint-disable-next-line no-console
  console.error(parsed.error.format());
  process.exit(1);
}

export const env = parsed.data;

export type Env = z.infer<typeof envSchema>;
