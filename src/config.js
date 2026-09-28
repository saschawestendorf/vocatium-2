// Zentrale, validierte Laufzeitkonfiguration aus Umgebungsvariablen.
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => (v === undefined ? undefined : ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase())));

const csv = z
  .string()
  .optional()
  .transform((v) => (v ? v.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : undefined));

const schema = z
  .object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('0.0.0.0'),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL fehlt'),
    DATABASE_SSL: bool,
    PUBLIC_BASE_URL: z.string().url().optional(),
    EVENT_CONFIG_PATH: z.string().default('config/event.json'),

    // Geheimnis für Code-/Token-Hashes. In Produktion Pflicht.
    APP_SECRET: z.string().optional(),
    ADMIN_USER: z.string().default('admin'),
    ADMIN_PASSWORD: z.string().optional(),

    // E-Mail
    EMAIL_PROVIDER: z.enum(['resend', 'console']).default('console'),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().default('Ein Tag Chef sein <noreply@example.com>'),
    EMAIL_REPLY_TO: z.string().optional(),

    // SMS
    SMS_PROVIDER: z.enum(['twilio', 'seven', 'console']).default('console'),
    SMS_SENDER: z.string().default('Rotary'),
    SMS_ALLOWED_COUNTRIES: csv,
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_FROM: z.string().optional(),
    TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
    SEVEN_API_KEY: z.string().optional(),

    // Verifizierung
    VERIFY_EMAIL: bool,
    VERIFY_PHONE: bool,
    CODE_TTL_MINUTES: z.coerce.number().int().min(1).max(60).default(10),
    CODE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
    CODE_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(600).default(30),
    CODE_MAX_SENDS_PER_TARGET_PER_HOUR: z.coerce.number().int().min(1).max(100).default(5),
  })
  .superRefine((env, ctx) => {
    const prod = env.NODE_ENV === 'production';
    const need = (key, cond, msg) => {
      if (cond && !env[key]) ctx.addIssue({ code: 'custom', path: [key], message: msg });
    };
    need('APP_SECRET', prod, 'APP_SECRET ist in Produktion Pflicht');
    need('ADMIN_PASSWORD', prod, 'ADMIN_PASSWORD ist in Produktion Pflicht');
    need('RESEND_API_KEY', env.EMAIL_PROVIDER === 'resend', 'RESEND_API_KEY fehlt');
    need('TWILIO_ACCOUNT_SID', env.SMS_PROVIDER === 'twilio', 'TWILIO_ACCOUNT_SID fehlt');
    need('TWILIO_AUTH_TOKEN', env.SMS_PROVIDER === 'twilio', 'TWILIO_AUTH_TOKEN fehlt');
    if (env.SMS_PROVIDER === 'twilio' && !env.TWILIO_FROM && !env.TWILIO_MESSAGING_SERVICE_SID) {
      ctx.addIssue({ code: 'custom', path: ['TWILIO_FROM'], message: 'TWILIO_FROM oder TWILIO_MESSAGING_SERVICE_SID fehlt' });
    }
    need('SEVEN_API_KEY', env.SMS_PROVIDER === 'seven', 'SEVEN_API_KEY fehlt');
    if (prod && env.APP_SECRET && env.APP_SECRET.length < 32) {
      ctx.addIssue({ code: 'custom', path: ['APP_SECRET'], message: 'APP_SECRET muss mind. 32 Zeichen lang sein' });
    }
  });

export function loadConfig(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Ungültige Konfiguration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    port: e.PORT,
    host: e.HOST,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL ?? false,
    publicBaseUrl: e.PUBLIC_BASE_URL?.replace(/\/+$/, ''),
    eventConfigPath: e.EVENT_CONFIG_PATH,
    appSecret: e.APP_SECRET || 'dev-secret-nicht-in-produktion-verwenden',
    admin: { user: e.ADMIN_USER, password: e.ADMIN_PASSWORD },
    email: {
      provider: e.EMAIL_PROVIDER,
      resendApiKey: e.RESEND_API_KEY,
      from: e.EMAIL_FROM,
      replyTo: e.EMAIL_REPLY_TO,
    },
    sms: {
      provider: e.SMS_PROVIDER,
      sender: e.SMS_SENDER,
      allowedCountries: e.SMS_ALLOWED_COUNTRIES ?? ['DE'],
      twilio: {
        accountSid: e.TWILIO_ACCOUNT_SID,
        authToken: e.TWILIO_AUTH_TOKEN,
        from: e.TWILIO_FROM,
        messagingServiceSid: e.TWILIO_MESSAGING_SERVICE_SID,
      },
      seven: { apiKey: e.SEVEN_API_KEY },
    },
    verify: {
      email: e.VERIFY_EMAIL ?? true,
      phone: e.VERIFY_PHONE ?? true,
      ttlMinutes: e.CODE_TTL_MINUTES,
      maxAttempts: e.CODE_MAX_ATTEMPTS,
      resendCooldownSeconds: e.CODE_RESEND_COOLDOWN_SECONDS,
      maxSendsPerTargetPerHour: e.CODE_MAX_SENDS_PER_TARGET_PER_HOUR,
    },
  };
}
