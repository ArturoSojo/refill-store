import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { QUERY_KEYS } from '@/lib/constants';
import type { StoreModal } from '@/types/models';
/** Hooks pequeños de interfaz. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { countdown } from '@/lib/format';
import { copyToClipboard } from '@/lib/utils';
import type { TimestampLike } from '@/types/models';

/** Cuenta atrás en formato mm:ss que se actualiza cada segundo. */
export function useCountdown(expiresAt: TimestampLike): { display: string | null; expired: boolean } {
  const [display, setDisplay] = useState<string | null>(() => countdown(expiresAt));

  useEffect(() => {
    setDisplay(countdown(expiresAt));
    const interval = setInterval(() => setDisplay(countdown(expiresAt)), 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  return { display, expired: display === null };
}

/** Copia un texto y marca "copiado" durante un par de segundos. */
export function useCopy(resetMs = 1800) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string, key = 'default') => {
      const success = await copyToClipboard(text);
      if (success) {
        setCopiedKey(key);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopiedKey(null), resetMs);
      }
      return success;
    },
    [resetMs]
  );

  return { copy, copiedKey, isCopied: (key = 'default') => copiedKey === key };
}

/** Estado persistido en `localStorage` (tolerante a modo privado de Safari). */
export function useLocalStorage<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      return stored ? (JSON.parse(stored) as T) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Cuota llena o almacenamiento bloqueado: sólo se pierde la persistencia.
      }
    },
    [key]
  );

  return [value, update] as const;
}

/** Retrasa un valor: evita disparar búsquedas en cada pulsación. */
export function useDebouncedValue<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timeout);
  }, [value, delay]);

  return debounced;
}

/** Actualiza el `<title>` de la pestaña. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} · Refill Store` : 'Refill Store';
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** Modales activos de la tienda (tutorial y avisos superpuestos). */
export function useStoreModals() {
  return useQuery({
    queryKey: QUERY_KEYS.modals,
    queryFn: () => api.get<{ modals: StoreModal[] }>('/modals', { anonymous: true }),
    // Cambian poco y los pide cada visita: media hora de caché sobra.
    staleTime: 30 * 60_000,
  });
}
