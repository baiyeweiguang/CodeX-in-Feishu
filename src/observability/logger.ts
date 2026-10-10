import pino from 'pino';

export function makeLogger(secret = '', destination?: string) {
  const scrub = (value: unknown): unknown => {
    if (typeof value === 'string') return secret ? value.split(secret).join('[REDACTED]') : value;
    if (value instanceof Error) return { name: value.name, message: scrub(value.message) };
    if (Array.isArray(value)) return value.map(scrub);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, /secret|token|authorization|password/i.test(k) ? '[REDACTED]' : scrub(v)]));
    return value;
  };
  return pino({ level: process.env.LOG_LEVEL ?? 'info', hooks: {
    logMethod(args, method) { method.apply(this, args.map(scrub) as Parameters<typeof method>); },
  } }, destination ? pino.destination(destination) : undefined);
}
