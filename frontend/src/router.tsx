import { createBrowserRouter, type RouteObject } from 'react-router';
import { PublicOnly, RequireAuth, RequireRole, RoleHomeRedirect } from '@/auth/guards';
import { AppShell } from '@/components/layout/AppShell';
import { LoginPage } from '@/pages/auth/LoginPage';
import { NotFoundPage } from '@/pages/shared/MiscPages';

// Screens are code-split: the sign-in page and app shell load first; each
// screen (and the map library, used by registration, profile and the donation
// form) is fetched when first opened.
const page = <T extends Record<string, unknown>>(load: () => Promise<T>, name: keyof T) => async () => ({
  Component: (await load())[name] as React.ComponentType,
});

const authPages = () => import('@/pages/auth/PasswordPages');
const recipient = () => import('@/pages/recipient/RecipientPages');
const recipientDeliveries = () => import('@/pages/recipient/RecipientDeliveries');
const volunteer = () => import('@/pages/volunteer/VolunteerPages');
const adminOverview = () => import('@/pages/admin/AdminOverview');
const adminOps = () => import('@/pages/admin/AdminOperations');
const adminPeople = () => import('@/pages/admin/AdminPeople');
const adminInsights = () => import('@/pages/admin/AdminInsights');

export const routes: RouteObject[] = [
  { index: true, element: <RoleHomeRedirect /> },
  // The reset link from the email works whether or not someone is signed in.
  { path: 'reset-password', lazy: page(authPages, 'ResetPasswordPage') },
  {
    element: <PublicOnly />,
    children: [
      { path: 'login', element: <LoginPage /> },
      { path: 'register', lazy: page(() => import('@/pages/auth/RegisterPage'), 'RegisterPage') },
      { path: 'forgot-password', lazy: page(authPages, 'ForgotPasswordPage') },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: 'notifications', lazy: page(() => import('@/pages/shared/NotificationsPage'), 'NotificationsPage') },
          { path: 'profile', lazy: page(() => import('@/pages/shared/ProfilePage'), 'ProfilePage') },
          { path: 'reports', lazy: page(() => import('@/pages/shared/ReportsPage'), 'ReportsPage') },
          {
            path: 'provider',
            element: <RequireRole role="PROVIDER" />,
            children: [
              { index: true, lazy: page(() => import('@/pages/provider/ProviderDashboard'), 'ProviderDashboard') },
              { path: 'donations', lazy: page(() => import('@/pages/provider/DonationsPage'), 'DonationsPage') },
              { path: 'donations/new', lazy: page(() => import('@/pages/provider/DonationFormPage'), 'DonationFormPage') },
              { path: 'donations/:id', lazy: page(() => import('@/pages/provider/DonationDetailPage'), 'DonationDetailPage') },
              { path: 'donations/:id/edit', lazy: page(() => import('@/pages/provider/DonationFormPage'), 'DonationFormPage') },
            ],
          },
          {
            path: 'recipient',
            element: <RequireRole role="RECIPIENT" />,
            children: [
              { index: true, lazy: page(recipient, 'RecipientDashboard') },
              { path: 'matches', lazy: page(recipient, 'MatchesPage') },
              { path: 'browse', lazy: page(recipient, 'BrowsePage') },
              { path: 'requirements', lazy: page(() => import('@/pages/recipient/RequirementsPage'), 'RequirementsPage') },
              { path: 'deliveries', lazy: page(recipientDeliveries, 'RecipientDeliveriesPage') },
              { path: 'deliveries/:id', lazy: page(recipientDeliveries, 'RecipientDeliveryPage') },
            ],
          },
          {
            path: 'volunteer',
            element: <RequireRole role="VOLUNTEER" />,
            children: [
              { index: true, lazy: page(volunteer, 'VolunteerDashboard') },
              { path: 'deliveries', lazy: page(volunteer, 'AssignmentsPage') },
              { path: 'deliveries/:id', lazy: page(volunteer, 'VolunteerDeliveryPage') },
              { path: 'availability', lazy: page(volunteer, 'AvailabilityPage') },
            ],
          },
          {
            path: 'admin',
            element: <RequireRole role="ADMIN" />,
            children: [
              { index: true, lazy: page(adminOverview, 'AdminDashboard') },
              { path: 'monitoring', lazy: page(adminOverview, 'MonitoringPage') },
              { path: 'pickups', lazy: page(adminOps, 'PickupQueuePage') },
              { path: 'organizations', lazy: page(adminOps, 'VerificationPage') },
              { path: 'users', lazy: page(adminPeople, 'UsersPage') },
              { path: 'incidents', lazy: page(adminPeople, 'IncidentsPage') },
              { path: 'reports', lazy: page(adminInsights, 'ReportsAdminPage') },
              { path: 'settings', lazy: page(adminInsights, 'SettingsPage') },
              { path: 'activity', lazy: page(adminInsights, 'AuditLogPage') },
            ],
          },
        ],
      },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
