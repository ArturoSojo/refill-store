/** Manejador central de errores: una sola forma de respuesta para el frontend. */
import type { Request, Response, NextFunction } from 'express';
import { AppError, isAppError } from '../lib/errors';
import { log } from '../lib/logger';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    ok: false,
    error: { code: 'not_found', message: `Ruta no encontrada: ${req.method} ${req.path}` },
  });
}

export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  // Express identifica el error handler por su aridad de 4: `next` debe estar.
  _next: NextFunction
) {
  if (isAppError(error)) {
    const appError = error as AppError;
    if (appError.status >= 500) {
      log.error('Error de aplicación', {
        code: appError.code,
        message: appError.message,
        path: req.path,
        uid: req.user?.uid,
        details: appError.details,
      });
    } else {
      log.info('Petición rechazada', {
        code: appError.code,
        message: appError.message,
        path: req.path,
        uid: req.user?.uid,
      });
    }

    res.status(appError.status).json({
      ok: false,
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details ? { details: appError.details } : {}),
      },
    });
    return;
  }

  log.error('Error no controlado', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    path: req.path,
    uid: req.user?.uid,
  });

  res.status(500).json({
    ok: false,
    error: {
      code: 'internal',
      message: 'Ocurrió un error inesperado. Intenta de nuevo en unos segundos.',
    },
  });
}
