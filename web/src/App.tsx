import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { StoreLayout } from '@/components/layout/StoreLayout';
import { AdminLayout } from '@/components/layout/AdminLayout';
import { RequireAuth, RequireStaff, ScrollToTop } from '@/components/common/Guards';

import { HomePage } from '@/pages/HomePage';
import { GamePage } from '@/pages/GamePage';
import { CheckoutPage } from '@/pages/CheckoutPage';
import { OrderPage } from '@/pages/OrderPage';
import { OrdersPage } from '@/pages/OrdersPage';
import { LoginPage } from '@/pages/LoginPage';
import { AccountPage } from '@/pages/AccountPage';
import { PlayerIdsPage } from '@/pages/PlayerIdsPage';
import { WalletPage } from '@/pages/WalletPage';
import { ReferralsPage } from '@/pages/ReferralsPage';
import { NotificationsPage } from '@/pages/NotificationsPage';
import { SupportPage, TicketPage } from '@/pages/SupportPage';
import { FaqPage, NotFoundPage } from '@/pages/FaqPage';

import { AdminDashboard } from '@/pages/admin/AdminDashboard';
import { AdminOrders } from '@/pages/admin/AdminOrders';
import { AdminOrderDetail } from '@/pages/admin/AdminOrderDetail';
import { AdminProducts } from '@/pages/admin/AdminProducts';
import { AdminGames } from '@/pages/admin/AdminGames';
import { AdminUsers, AdminUserDetail } from '@/pages/admin/AdminUsers';
import { AdminCoupons } from '@/pages/admin/AdminCoupons';
import { AdminSettings } from '@/pages/admin/AdminSettings';
import { AdminSupport, AdminLogs } from '@/pages/admin/AdminSupport';
import { AdminAlerts } from '@/pages/admin/AdminAlerts';

export function App() {
  return (
    <BrowserRouter>
      <ScrollToTop />

      <Routes>
        {/* --- Tienda --- */}
        <Route element={<StoreLayout />}>
          <Route index element={<HomePage />} />
          <Route path="juego/:slug" element={<GamePage />} />
          {/* El checkout es público hasta el momento de pagar: así el usuario
              ve el precio antes de que se le pida iniciar sesión. */}
          <Route path="comprar/:productId" element={<CheckoutPage />} />
          <Route path="entrar" element={<LoginPage />} />
          <Route path="ayuda" element={<FaqPage />} />
          <Route path="soporte" element={<SupportPage />} />

          <Route
            path="soporte/:ticketId"
            element={
              <RequireAuth>
                <TicketPage />
              </RequireAuth>
            }
          />
          <Route
            path="mis-ordenes"
            element={
              <RequireAuth>
                <OrdersPage />
              </RequireAuth>
            }
          />
          <Route
            path="orden/:orderId"
            element={
              <RequireAuth>
                <OrderPage />
              </RequireAuth>
            }
          />
          <Route
            path="cuenta"
            element={
              <RequireAuth>
                <AccountPage />
              </RequireAuth>
            }
          />
          <Route
            path="cuenta/ids"
            element={
              <RequireAuth>
                <PlayerIdsPage />
              </RequireAuth>
            }
          />
          <Route
            path="cuenta/saldo"
            element={
              <RequireAuth>
                <WalletPage />
              </RequireAuth>
            }
          />
          <Route
            path="cuenta/referidos"
            element={
              <RequireAuth>
                <ReferralsPage />
              </RequireAuth>
            }
          />
          <Route
            path="cuenta/notificaciones"
            element={
              <RequireAuth>
                <NotificationsPage />
              </RequireAuth>
            }
          />

          <Route path="*" element={<NotFoundPage />} />
        </Route>

        {/* --- Panel de administración --- */}
        <Route
          path="admin"
          element={
            <RequireStaff>
              <AdminLayout />
            </RequireStaff>
          }
        >
          <Route index element={<AdminDashboard />} />
          <Route path="ordenes" element={<AdminOrders />} />
          <Route path="ordenes/:orderId" element={<AdminOrderDetail />} />
          <Route path="productos" element={<AdminProducts />} />
          <Route path="juegos" element={<AdminGames />} />
          <Route path="usuarios" element={<AdminUsers />} />
          <Route path="usuarios/:uid" element={<AdminUserDetail />} />
          <Route path="cupones" element={<AdminCoupons />} />
          <Route path="soporte" element={<AdminSupport />} />
          <Route path="avisos" element={<AdminAlerts />} />
          <Route path="configuracion" element={<AdminSettings />} />
          <Route path="bitacora" element={<AdminLogs />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
