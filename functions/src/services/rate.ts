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
import * as pabilo from './pabilo';
import * as adminAlerts from './adminAlerts';

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

export interface ReferenceRate {
  value: number;
  /** De dónde salió, para poder decirlo en el panel y en el historial. */
  source: 'pabilo' | 'public';
}

/**
 * Tasa del BCV de referencia, sin margen.
 *
 * Primero Pabilo, que es el proveedor de verificación de pagos que ya se paga y
 * publica la tasa oficial autenticada (`GET /exchange/rate`). La fuente pública
 * queda de respaldo: es gratuita y sin contrato, así que puede desaparecer sin
 * aviso —de hecho es lo que pasó con `pydolarve.org`, que lleva devolviendo 404
 * desde antes de que nadie lo notara, dejando el auto-refresco muerto mientras
 * el panel lo mostraba activo—.
 */
export async function fetchReferenceRate(): Promise<ReferenceRate | null> {
  const fromPabilo = await pabilo.getExchangeRate().catch((error) => {
    log.warn('Falló la consulta de tasa a Pabilo', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  if (fromPabilo) return { value: fromPabilo.usd, source: 'pabilo' };

  const response = await fetchJson<RateSourcePayload>(rateSourceUrl(), {
    method: 'GET',
    timeoutMs: 12_000,
    retries: 1,
  });

  if (!response.ok) {
    log.warn('No se pudo leer la tasa de referencia de respaldo', { status: response.status });
    return null;
  }

  const value = extractRate(response.data);
  return value === null ? null : { value, source: 'public' };
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
    // Antes esto sólo dejaba un aviso en los registros: el panel seguía
    // diciendo «actualización automática activa» mientras llevaba semanas sin
    // actualizar nada. Ahora el motivo sube hasta quien pulsa el botón y, en la
    // tarea programada, hasta los avisos del equipo.
    return {
      updated: false,
      previous,
      current: previous,
      reason:
        'Ninguna fuente devolvió la tasa del BCV (ni Pabilo ni la de respaldo). Se mantiene la anterior.',
    };
  }

  const current = round(reference.value * (1 + config.rate.markupPercent / 100), 4);

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
    reference: reference.value,
    referenceSource: reference.source,
    markupPercent: config.rate.markupPercent,
    source: 'auto',
    updatedBy: 'system',
    createdAt: now(),
  });

  log.info('Tasa actualizada automáticamente', { previous, current, reference });
  return {
    updated: true,
    previous,
    current,
    reason:
      `Tasa del BCV ${reference.value} ${reference.source === 'pabilo' ? '(Pabilo)' : '(fuente de respaldo)'}` +
      ` + ${config.rate.markupPercent}% de margen.`,
  };
}

export async function history(limit = 50) {
  const snap = await rateHistory().orderBy('createdAt', 'desc').limit(limit).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

/**
 * Avisa al equipo si la tasa lleva demasiado sin poder actualizarse.
 *
 * El umbral evita ruido por un fallo puntual de la fuente: sólo salta cuando el
 * precio que se está cobrando ya es viejo de verdad.
 */
const STALE_RATE_HOURS = 6;

export async function alertStaleRate(reason: string): Promise<void> {
  const config = await getConfig({ fresh: true });

  const updatedAt = config.rate.updatedAt;
  const millis =
    updatedAt && typeof (updatedAt as { toMillis?: () => number }).toMillis === 'function'
      ? (updatedAt as { toMillis: () => number }).toMillis()
      : null;
  if (millis === null) return;

  const hours = (Date.now() - millis) / 3_600_000;
  if (hours < STALE_RATE_HOURS) return;

  await adminAlerts.alert({
    kind: 'rate_stale',
    severity: 'warning',
    title: 'La tasa lleva sin actualizarse',
    body: [
      `Van ${Math.floor(hours)} horas con la tasa en ${config.rate.value} Bs.`,
      reason,
      'Revisa la fuente o fíjala a mano desde Configuración.',
    ].join(' '),
    link: '/admin/configuracion',
    data: { value: config.rate.value, hours: Math.floor(hours) },
  });
}
