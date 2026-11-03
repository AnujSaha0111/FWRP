import { api } from '@/lib/api';
import type {
  AppNotification,
  Category,
  Delivery,
  DonationDetail,
  DonationHistoryItem,
  DonationInput,
  Donation,
  Incident,
  IncidentType,
  MatchSummary,
  Organization,
  OrganizationType,
  Page,
  Profile,
  ProviderDashboard,
  Role,
  User,
} from './types';

// One function per backend endpoint used by the app. Paths and payloads follow
// the backend docs (docs/*.md).

export interface RegisterInput {
  name: string;
  email: string;
  phone: string;
  password: string;
  role: Exclude<Role, 'ADMIN'>;
  orgName?: string;
  address?: string;
  organizationType?: OrganizationType;
  latitude?: number;
  longitude?: number;
}

export const authApi = {
  login: (email: string, password: string) =>
    api<{ user: User }>('/api/auth/login', { method: 'POST', body: { email, password } }),
  logout: () => api<unknown>('/api/auth/logout', { method: 'POST' }),
  register: (input: RegisterInput) =>
    api<{ user: User; organization: Organization | null }>('/api/auth/register', { method: 'POST', body: { ...input } }),
  forgotPassword: (email: string) =>
    api<{ message: string }>('/api/auth/forgot-password', { method: 'POST', body: { email } }),
  resetPassword: (token: string, newPassword: string) =>
    api<{ reset: true }>('/api/auth/reset-password', { method: 'POST', body: { token, newPassword } }),
  changePassword: (currentPassword: string, newPassword: string) =>
    api<{ changed: true }>('/api/auth/change-password', { method: 'POST', body: { currentPassword, newPassword } }),
};

export const profileApi = {
  me: () => api<Profile>('/api/users/me'),
  update: (input: { name?: string; phone?: string }) => api<Profile>('/api/users/me', { method: 'PUT', body: input }),
};

export const organizationApi = {
  mine: () => api<{ organization: Organization }>('/api/organizations/me'),
  update: (input: Partial<Pick<Organization, 'name' | 'address' | 'contactInformation' | 'latitude' | 'longitude'>>) =>
    api<{ organization: Organization }>('/api/organizations/me', { method: 'PUT', body: input }),
};

export const categoriesApi = {
  list: () => api<{ categories: Category[] }>('/api/categories'),
};

export const donationsApi = {
  /** All of the provider's own donations (any status, newest first), with timelines. */
  history: (page = 1, limit = 100) =>
    api<Page<DonationHistoryItem>>('/api/donations/history', { query: { provider_id: 'me', page, limit } }),
  get: (id: string) => api<{ donation: DonationDetail }>(`/api/donations/${id}`),
  create: (input: DonationInput) => api<{ donation: Donation }>('/api/donations', { method: 'POST', body: { ...input } }),
  update: (id: string, input: Partial<DonationInput>) =>
    api<{ donation: Donation }>(`/api/donations/${id}`, { method: 'PUT', body: { ...input } }),
  cancel: (id: string) => api<{ donation: Donation }>(`/api/donations/${id}/cancel`, { method: 'POST' }),
};

export const matchesApi = {
  forDonation: (donationId: string, status: MatchSummary['status'] = 'RECOMMENDED') =>
    api<Page<MatchSummary>>('/api/matches', { query: { donationId, status, limit: 20 } }),
  refreshDonation: (donationId: string) =>
    api<{ recommended: number }>(`/api/matches/donations/${donationId}/refresh`, { method: 'POST' }),
};

export const deliveriesApi = {
  list: (query: { donationId?: string; active?: boolean; page?: number; limit?: number } = {}) =>
    api<Page<Delivery>>('/api/deliveries', {
      query: { ...query, active: query.active === undefined ? undefined : String(query.active) },
    }),
  get: (id: string) => api<{ delivery: Delivery }>(`/api/deliveries/${id}`),
  confirmHandover: (id: string) => api<{ delivery: Delivery }>(`/api/deliveries/${id}/handover`, { method: 'POST' }),
};

export const notificationsApi = {
  list: (page = 1, unread = false) =>
    api<Page<AppNotification>>('/api/notifications', { query: { page, limit: 20, unread: unread ? 'true' : undefined } }),
  unreadCount: () => api<{ count: number }>('/api/notifications/unread-count'),
  markRead: (id: string) => api<{ notification: AppNotification }>(`/api/notifications/${id}/read`, { method: 'POST' }),
  markAllRead: () => api<{ count: number }>('/api/notifications/read-all', { method: 'POST' }),
};

export const analyticsApi = {
  dashboard: <T = ProviderDashboard>() => api<T>('/api/analytics/dashboard'),
};

export interface IncidentInput {
  type: IncidentType;
  subjectUserId?: string;
  donationId?: string;
  deliveryId?: string;
  reason: string;
  description: string;
}

export const incidentsApi = {
  mine: () => api<Page<Incident>>('/api/incidents', { query: { limit: 50 } }),
  create: (input: IncidentInput) => api<{ incident: Incident }>('/api/incidents', { method: 'POST', body: { ...input } }),
};
