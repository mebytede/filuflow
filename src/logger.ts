// Structured logging via pino. Engine code never uses console.log.
import { pino, type Logger as PinoLogger } from 'pino';

export type Logger = Pick<PinoLogger, 'debug' | 'info' | 'warn' | 'error' | 'child'>;

let root: PinoLogger | undefined;

export function getLogger(): Logger {
  if (!root) {
    root = pino(
      {
        level: process.env.FILUFLOW_LOG_LEVEL ?? (process.env.VITEST ? 'silent' : 'info'),
        base: undefined,
        redact: {
          paths: ['credentials', '*.credentials', 'password', '*.password', 'token', '*.token', 'apiKey', '*.apiKey'],
          censor: '***',
        },
      },
      pino.destination(2),
    );
  }
  return root;
}

export function setLogger(logger: PinoLogger): void {
  root = logger;
}
