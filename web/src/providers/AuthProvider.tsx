/**
 * Sesión del usuario.
 *
 * Combina dos fuentes:
 *  - Firebase Auth (identidad + custom claims `admin`/`staff` dentro del token).
 *  - La API (`/api/me`), que crea el perfil en Firestore la primera vez y
 *    devuelve saldo, nivel, estadísticas y notificaciones sin leer.
 *
 * El rol se lee del TOKEN, no del documento de usuario: es lo único que las
 * reglas de seguridad consideran verdad.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  updateProfile,
  signOut as firebaseSignOut,
  type User,
} from 'firebase/auth';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { auth, googleProvider } from '@/lib/firebase';
import { api } from '@/lib/api';
import { QUERY_KEYS } from '@/lib/constants';
import type { MeResponse } from '@/types/models';

interface AuthContextValue {
  /** Usuario de Firebase, o `null` si no hay sesión. */
  user: User | null;
  /** Perfil extendido que devuelve la API. */
  me: MeResponse | null;
  isAdmin: boolean;
  isStaff: boolean;
  /** `true` mientras se resuelve el estado inicial de la sesión. */
  loading: boolean;
  /** `true` mientras se está completando un inicio de sesión. */
  signingIn: boolean;
  profileLoading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  registerWithEmail: (email: string, password: string, name: string) => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

/** Traduce los códigos de Firebase Auth a algo que un cliente entienda. */
// eslint-disable-next-line react-refresh/only-export-components
export function authErrorMessage(error: unknown): string {
  const code = (error as { code?: string }).code ?? '';

  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Correo o contraseña incorrectos.';
    case 'auth/invalid-email':
      return 'Ese correo no tiene un formato válido.';
    case 'auth/email-already-in-use':
      return 'Ya existe una cuenta con ese correo. Inicia sesión.';
    case 'auth/weak-password':
      return 'La contraseña debe tener al menos 6 caracteres.';
    case 'auth/too-many-requests':
      return 'Demasiados intentos. Espera unos minutos e intenta de nuevo.';
    case 'auth/user-disabled':
      return 'Esta cuenta está suspendida. Contacta al soporte.';
    case 'auth/operation-not-allowed':
      return 'El acceso con correo y contraseña no está habilitado en Firebase.';
    case 'auth/network-request-failed':
      return 'Sin conexión. Revisa tu internet.';
    default:
      return error instanceof Error ? error.message : 'No pudimos completar el acceso.';
  }
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [claims, setClaims] = useState<{ admin: boolean; staff: boolean }>({
    admin: false,
    staff: false,
  });
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const queryClient = useQueryClient();

  useEffect(() => {
    // Safari en iOS bloquea popups en algunos contextos y caemos a redirect:
    // hay que recoger el resultado al volver.
    getRedirectResult(auth).catch(() => undefined);

    const unsubscribe = onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);

      if (nextUser) {
        try {
          const token = await nextUser.getIdTokenResult();
          setClaims({
            admin: token.claims.admin === true,
            staff: token.claims.admin === true || token.claims.staff === true,
          });
        } catch {
          setClaims({ admin: false, staff: false });
        }
      } else {
        setClaims({ admin: false, staff: false });
        queryClient.removeQueries({ queryKey: QUERY_KEYS.me });
      }

      setLoading(false);
    });

    return unsubscribe;
  }, [queryClient]);

  const profileQuery = useQuery({
    queryKey: QUERY_KEYS.me,
    queryFn: () => api.get<MeResponse>('/me'),
    enabled: Boolean(user),
    staleTime: 60_000,
    retry: 1,
  });

  const signInWithGoogle = useCallback(async () => {
    setSigningIn(true);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      const code = (error as { code?: string }).code ?? '';

      // El usuario cerró la ventana a propósito: no es un error que reportar.
      if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
        return;
      }

      // Navegador que bloquea popups (típico en móvil): se intenta por redirect.
      if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(auth, googleProvider);
        return;
      }

      throw error;
    } finally {
      setSigningIn(false);
    }
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string) => {
    setSigningIn(true);
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } finally {
      setSigningIn(false);
    }
  }, []);

  const registerWithEmail = useCallback(
    async (email: string, password: string, name: string) => {
      setSigningIn(true);
      try {
        const credential = await createUserWithEmailAndPassword(auth, email.trim(), password);
        if (name.trim()) {
          await updateProfile(credential.user, { displayName: name.trim() });
        }
      } finally {
        setSigningIn(false);
      }
    },
    []
  );

  const resetPassword = useCallback(async (email: string) => {
    await sendPasswordResetEmail(auth, email.trim());
  }, []);

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth);
    queryClient.clear();
  }, [queryClient]);

  const refreshProfile = useCallback(async () => {
    // Fuerza un token nuevo para recoger cambios de rol hechos desde el panel.
    if (auth.currentUser) {
      const token = await auth.currentUser.getIdTokenResult(true);
      setClaims({
        admin: token.claims.admin === true,
        staff: token.claims.admin === true || token.claims.staff === true,
      });
    }
    await queryClient.invalidateQueries({ queryKey: QUERY_KEYS.me });
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      me: profileQuery.data ?? null,
      // El claim manda, pero si la API ya respondió con un rol superior se
      // respeta (evita un parpadeo justo después de promover a alguien).
      isAdmin: claims.admin || profileQuery.data?.isAdmin === true,
      isStaff: claims.staff || profileQuery.data?.isStaff === true,
      loading,
      signingIn,
      profileLoading: profileQuery.isLoading,
      signInWithGoogle,
      signInWithEmail,
      registerWithEmail,
      resetPassword,
      signOut,
      refreshProfile,
    }),
    [
      user,
      profileQuery.data,
      profileQuery.isLoading,
      claims,
      loading,
      signingIn,
      signInWithGoogle,
      signInWithEmail,
      registerWithEmail,
      resetPassword,
      signOut,
      refreshProfile,
    ]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de <AuthProvider>.');
  return context;
}
