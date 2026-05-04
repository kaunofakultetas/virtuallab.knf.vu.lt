import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  
  redact: ['req.headers.authorization', 'password'],
  transport: process.env.NODE_ENV !== 'production' 
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        }
      } 
    : undefined,
});