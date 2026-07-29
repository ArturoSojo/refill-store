/**
 * Tasa Bs/USD.
 *
 * Por defecto es manual (el admin la fija desde el panel, valor inicial 760,50
 * según las especificaciones). Si se activa `rate.autoRefresh`, una tarea
 * programada consulta una fuente pública del BCV y le suma el margen configurado.
 *
 * Cada cambio queda en `rateHistory` para poder auditar a qué tasa se vendió.
 */
import { rateHistory, now } from '../config/firebase';
import { rateSourceUrl } from '../config/env';
import { fetchJson } from '../lib/fetchJson';
import { log } from '../lib/logger';
import { round } from '../lib/money';
import { getConfig, updateConfig } from './settings';

interface RateSourcePayload {
  monitors?: Record<string, { price?: number }>;
  price?: number;
  promedio?: number;
  [key: string]: unknown;
}

/** Extrae el valor del BCV de las formas más comunes que devuelven estas APIs. */
function extractRate(payload: RateSourcePayload | null): number | null {
  if (!payload) return null;

  const candidates = [
    payload.monitors?.bcv?.price,
    payload.monitors?.oficial?.price,
    payload.price,
    payload.promedio,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'number' && candidate > 0) return candidate;
  }
  return null;
}

/** Consulta la fuente pública. Devuelve `null` si no se pudo leer. */
export async function fetchReferenceRate(): Promise<number | null> {
  const response = await fetchJson<RateSourcePayload>(rateSourceUrl(), {
    method: 'GET',
    timeoutMs: 12_000,
    retries: 1,
  });

  if (!response.ok) {
    log.warn('No se pudo leer la tasa de referencia', { status: response.status });
    return null;
  }
  return extractRate(response.data);
}

export interface RateUpdateResult {
  updated: boolean;
  previous: number;
  current: number;
  reason: string;
}

/** Fija la tasa manualmente y registra el cambio. */
export async function setManualRate(
  value: number,
  updatedBy: string | null
): Promise<RateUpdateResult> {
  const config = await getConfig({ fresh: true });
  const previous = config.rate.value;
  const current = round(value, 4);

  await updateConfig(
    {
      rate: {
        ...config.rate,
        value: current,
        source: 'manual',
        updatedAt: now(),
        updatedBy,
      },
    },
    updatedBy
  );

  await rateHistory().add({
    value: current,
    previous,
    source: 'manual',
    updatedBy,
    createdAt: now(),
  });

  return { updated: true, previous, current, reason: 'Tasa fijada manualmente.' };
}

/**
 * Refresca la tasa desde la fuente pública si el auto-refresco está activo.
 * Se llama desde la tarea programada y desde el botón del panel.
 */
export async function refreshAutoRate(force = false): Promise<RateUpdateResult> {
  const config = await getConfig({ fresh: true });
  const previous = config.rate.value;

  if (!config.rate.autoRefresh && !force) {
    return {
      updated: false,
      previous,
      current: previous,
      reason: 'El auto-refresco de tasa está desactivado.',
    };
  }

  const reference = await fetchReferenceRate();
  if (reference === null) {
    return {
      updated: false,
      previous,
      current: previous,
      reason: 'No se pudo obtener la tasa de referencia; se mantiene la anterior.',
    };
  }

  const current = round(reference * (1 + config.rate.markupPercent / 100), 4);

  // Un salto enorme casi siempre significa que la fuente cambió de formato.
  // Preferimos no vender a una tasa absurda y avisar en los logs.
  const changePercent = previous > 0 ? Math.abs((current - previous) / previous) * 100 : 0;
  if (!force && previous > 0 && changePercent > 25) {
    log.warn('Variación de tasa sospechosa, no se aplica', { previous, current });
    return {
      updated: false,
      previous,
      current: previous,
      reason: `La tasa obtenida (${current}) varía ${changePercent.toFixed(1)}% respecto a la actual. Revísala manualmente.`,
    };
  }

  await updateConfig(
    {
      rate: {
        ...config.rate,
        value: current,
        source: 'auto',
        updatedAt: now(),
        updatedBy: 'system',
      },
    },
    'system'
  );

  await rateHistory().add({
    value: current,
    previous,
    reference,
    markupPercent: config.rate.markupPercent,
    source: 'auto',
    updatedBy: 'system',
    createdAt: now(),
  });

  log.info('Tasa actualizada automáticamente', { previous, current, reference });
  return { updated: true, previous, current, reason: 'Tasa actualizada desde la fuente pública.' };
}

export async function history(limit = 50) {
  const snap = await rateHistory().orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
