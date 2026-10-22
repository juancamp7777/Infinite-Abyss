import fs from 'fs';
import path from 'path';
import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

const customFormat = printf(({ level, message, timestamp, traceId, event }) => {
  const traceOutput = traceId ? ` [TraceID: ${traceId}]` : '';
  const eventOutput = event ? ` [Event: ${event}]` : '';
  return `${timestamp} ${level}:${traceOutput}${eventOutput} ${message}`;
});

const transports: winston.transport[] = [
  // Consola para desarrollo
  new winston.transports.Console({
    format: combine(
      colorize(),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      customFormat
    ),
  }),
];

// Archivo de registro (LOG_DIR configurable). Si no se puede escribir, solo consola.
const logDir = process.env.LOG_DIR || 'logs';
let fileError: unknown = null;
try {
  fs.mkdirSync(logDir, { recursive: true });
  fs.accessSync(logDir, fs.constants.W_OK);
  const file = new winston.transports.File({ filename: path.join(logDir, 'audit.log') });
  file.on('error', () => {
    /* un fallo de escritura no debe tumbar el proceso */
  });
  transports.push(file);
} catch (e) {
  fileError = e;
}

export const logger = winston.createLogger({
  level: 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.json() // Estructurado en JSON para auditorías y datadog/elk
  ),
  transports,
});

if (fileError) {
  logger.warn(`Registro en archivo desactivado (${logDir}): ${(fileError as Error).message}`);
}
