/** Utilidades de Express: respuestas uniformes, validación y captura de errores. */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, ZodSchema } from 'zod';
import { invalidArgument } from './errors';

/** Envoltorio de respuesta exitosa. */
export function ok<T>(res: Response, data: T, status = 200): Response {
  return res.status(status).json({ ok: true, data });
}

/** Envuelve un handler async para que los rechazos lleguen al error handler. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

function formatZodIssues(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || '_';
    if (!fields[path]) fields[path] = issue.message;
  }
  return fields;
}

/** Valida `req.body` y devuelve el objeto ya tipado. */
export function parseBody<T extends ZodSchema>(req: Request, schema: T): z.infer<T> {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    throw invalidArgument('Los datos enviados no son válidos.', {
      fields: formatZodIssues(result.error),
    });
  }
  return result.data;
}

/** Valida `req.query` y devuelve el objeto ya tipado. */
export function parseQuery<T extends ZodSchema>(req: Request, schema: T): z.infer<T> {
  const result = schema.safeParse(req.query ?? {});
  if (!result.success) {
    throw invalidArgument('Los parámetros de consulta no son válidos.', {
      fields: formatZodIssues(result.error),
    });
  }
  return result.data;
}

/** Valida `req.params` y devuelve el objeto ya tipado. */
export function parseParams<T extends ZodSchema>(req: Request, schema: T): z.infer<T> {
  const result = schema.safeParse(req.params ?? {});
  if (!result.success) {
    throw invalidArgument('Ruta inválida.', { fields: formatZodIssues(result.error) });
  }
  return result.data;
}

/** IP real del cliente detrás del proxy de Cloud Functions / Hosting. */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0];
  }
  return req.ip ?? null;
}

export function userAgent(req: Request): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 300) : null;
}

/** Parámetros de paginación comunes a los listados del panel. */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().optional(),
});
