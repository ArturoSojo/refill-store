import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { App } from './App';
import { AuthProvider } from '@/providers/AuthProvider';
import { ConfigProvider } from '@/providers/ConfigProvider';
import { ApiError } from '@/lib/api';
import './styles/index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry(failureCount, error) {
        // Reintentar un 401/403/404 no arregla nada y retrasa el mensaje al
        // usuario; sólo se reintentan fallos de red o del servidor.
        if (error instanceof ApiError) {
          if (['unauthenticated', 'forbidden', 'not_found', 'invalid_argument'].includes(error.code)) {
            return false;
          }
        }
        return failureCount < 2;
      },
    },
    mutations: {
      retry: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ConfigProvider>
          <App />
          <Toaster
            position="top-center"
            containerStyle={{ top: 70 }}
            toastOptions={{
              duration: 4000,
              style: {
                background: '#171724',
                color: '#E2E8F0',
                border: '1px solid #2A2A3F',
                borderRadius: '14px',
                fontSize: '14px',
                maxWidth: '92vw',
              },
              success: { iconTheme: { primary: '#22C55E', secondary: '#0A0A11' } },
              error: { iconTheme: { primary: '#EF4444', secondary: '#0A0A11' }, duration: 6000 },
            }}
          />
        </ConfigProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>
);
