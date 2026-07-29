/**
 * Configuración pública de la tienda (tasa, datos bancarios, avisos).
 *
 * Se consulta una vez y se refresca cada pocos minutos: la tasa puede cambiar
 * mientras alguien navega, y el precio en bolívares depende de ella.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { QUERY_KEYS } from '@/lib/constants';
import type { PublicConfig } from '@/types/models';

interface ConfigContextValue {
  config: PublicConfig | null;
  loading: boolean;
  error: unknown;
  rate: number;
  /** Convierte dólares a bolívares con la tasa vigente. */
  toBs: (usd: number) => number;
}

const ConfigContext = createContext<ConfigContextValue | undefined>(undefined);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const query = useQuery({
    queryKey: QUERY_KEYS.config,
    queryFn: () => api.get<PublicConfig>('/config', { anonymous: true }),
    staleTime: 120_000,
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });

  const rate = query.data?.rate ?? 0;

  const value: ConfigContextValue = {
    config: query.data ?? null,
    loading: query.isLoading,
    error: query.error,
    rate,
    toBs: (usd: number) => Math.round(usd * rate * 100) / 100,
  };

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useConfig(): ConfigContextValue {
  const context = useContext(ConfigContext);
  if (!context) throw new Error('useConfig debe usarse dentro de <ConfigProvider>.');
  return context;
}
