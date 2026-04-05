import pino from 'pino';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync, existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logsDir = join(__dirname, '..', '..', 'logs');

// Ensure logs directory exists
if (!existsSync(logsDir)) {
  mkdirSync(logsDir, { recursive: true });
}

const isDev = process.env.NODE_ENV !== 'production';

// Configure transports
const transport = isDev
  ? pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    })
  : pino.transport({
      targets: [
        {
          target: 'pino/file',
          options: { destination: join(logsDir, 'slack-bot.log') },
          level: 'info',
        },
        {
          target: 'pino/file',
          options: { destination: 2 }, // stderr
          level: 'warn',
        },
      ],
    });

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'SLACK_APP_TOKEN',
        'SLACK_BOT_TOKEN',
        'SLACK_SIGNING_SECRET',
        'env.SLACK_APP_TOKEN',
        'env.SLACK_BOT_TOKEN',
      ],
      censor: '[REDACTED]',
    },
  },
  transport
);

export function createChildLogger(component: string) {
  return logger.child({ component });
}
