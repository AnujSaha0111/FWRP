import { api, apiDownload } from '@/lib/api';
import type {
  AdminDashboard,
  AdminUser,
  AuditLogEntry,
  AvailabilityWindow,
  AvailableVolunteer,
  Delivery,
  DeliveryStatus,
  Donation,
  DonationStatus,
  ImpactKpis,
  Incident,
  IncidentStatus,
  IncidentType,
  MatchSummary,
  Monitoring,
  Organization,
  OrganizationsPage,
  Page,
  PendingAssignments,
  RecipientDashboard,
  Report,
  Requirement,
  RequirementInput,
  Role,
  SettingView,
  UserStatus,
  VerificationStatus,
  VolunteerDashboard,
} from './types';

// Endpoints for the recipient, volunteer and admin screens.

type Query = Record<string, string | number | boolean | undefined | null>;

export const recipientApi = {
  dashboard: () => api<RecipientDashboard>('/api/analytics/dashboard'),
  /** Own organization's requirements + other organizations' open ones (filter by organization_id). */
  requirements: (query: Query = {}) => api<Page<Requirement>>('/api/requirements', { query: { limit: 100, ...query } }),
  createRequirement: (input: RequirementInput) =>
    api<{ requirement: Requirement }>('/api/requirements', { method: 'POST', body: { ...input } }),
  updateRequirement: (id: string, input: Partial<RequirementInput>) =>
    api<{ requirement: Requirement }>(`/api/requirements/${id}`, { method: 'PUT', body: { ...input } }),
  cancelRequirement: (id: string) => api<{ requirement: Requirement }>(`/api/requirements/${id}/cancel`, { method: 'POST' }),

  matches: (query: Query = {}) => api<Page<MatchSummary>>('/api/matches', { query: { limit: 50, ...query } }),
  acceptMatch: (id: string) => api<{ donation: { id: string }; allocation: { committedQuantity: number } }>(`/api/matches/${id}/accept`, { method: 'POST' }),
  rejectMatch: (id: string) => api<{ match: MatchSummary }>(`/api/matches/${id}/reject`, { method: 'POST' }),

  /** Donations open for acceptance right now. */
  browseDonations: (query: Query = {}) => api<Page<Donation & { time_remaining: number }>>('/api/donations', { query: { limit: 50, ...query } }),
  acceptDonation: (donationId: string, requirementId: string) =>
    api<{ donation: { id: string } }>(`/api/donations/${donationId}/accept`, { method: 'POST', body: { requirementId } }),

  deliveries: (query: Query = {}) => api<Page<Delivery>>('/api/deliveries', { query: { limit: 50, ...query } }),
  confirmReceipt: (id: string, input: { quantityReceived?: number; receiverName?: string; notes?: string }) =>
    api<{ delivery: Delivery }>(`/api/deliveries/${id}/confirm`, { method: 'POST', body: input }),
};

export const volunteerApi = {
  dashboard: () => api<VolunteerDashboard>('/api/analytics/dashboard'),
  availability: () => api<{ windows: AvailabilityWindow[] }>('/api/volunteers/me/availability'),
  addAvailability: (availableFrom: string, availableUntil: string) =>
    api<{ window: AvailabilityWindow }>('/api/volunteers/me/availability', { method: 'POST', body: { availableFrom, availableUntil } }),
  removeAvailability: (id: string) => api<{ deleted: true }>(`/api/volunteers/me/availability/${id}`, { method: 'DELETE' }),

  deliveries: (query: Query = {}) => api<Page<Delivery>>('/api/deliveries', { query: { limit: 50, ...query } }),
  delivery: (id: string) => api<{ delivery: Delivery }>(`/api/deliveries/${id}`),
  respond: (id: string, action: 'ACCEPT' | 'DECLINE', reason?: string) =>
    api<{ delivery: Delivery }>(`/api/deliveries/${id}/respond`, { method: 'POST', body: reason ? { action, reason } : { action } }),
  advance: (id: string, status: Extract<DeliveryStatus, 'AT_PICKUP' | 'PICKED_UP' | 'IN_TRANSIT' | 'DELIVERED'>, proofOfDelivery?: string) =>
    api<{ delivery: Delivery }>(`/api/deliveries/${id}/status`, {
      method: 'POST',
      body: proofOfDelivery ? { status, proofOfDelivery } : { status },
    }),
};

export const adminApi = {
  dashboard: () => api<AdminDashboard>('/api/analytics/dashboard'),
  impact: (query: Query = {}) => api<ImpactKpis>('/api/analytics/impact', { query }),
  report: (query: Query = {}) => api<Report>('/api/analytics/reports', { query: { ...query, format: 'json' } }),
  reportCsv: (query: Query = {}) => apiDownload('/api/analytics/reports', { ...query, format: 'csv' }),

  organizations: (status?: VerificationStatus, page = 1) =>
    api<OrganizationsPage>('/api/admin/organizations', { query: { status, page, limit: 50 } }),
  reviewOrganization: (id: string) => api<{ organization: Organization }>(`/api/admin/organizations/${id}/review`, { method: 'PUT' }),
  verifyOrganization: (id: string, action: 'VERIFY' | 'REJECT', reason?: string) =>
    api<{ organization: Organization }>(`/api/admin/organizations/${id}/verify`, {
      method: 'PUT',
      body: reason ? { action, reason } : { action },
    }),

  users: (query: { role?: Role; status?: UserStatus; q?: string; page?: number }) =>
    api<Page<AdminUser>>('/api/admin/users', { query: { ...query, limit: 25 } }),
  user: (id: string) =>
    api<{ user: AdminUser; activity: { donations: number; deliveries: number; incidentsReported: number; incidentsAbout: number } }>(
      `/api/admin/users/${id}`
    ),
  setUserStatus: (id: string, status: UserStatus, reason: string) =>
    api<{ user: AdminUser }>(`/api/admin/users/${id}/status`, { method: 'PUT', body: { status, reason } }),

  pending: () => api<PendingAssignments>('/api/deliveries/pending'),
  availableVolunteers: (donationId: string) =>
    api<{ from: string; until: string; volunteers: AvailableVolunteer[] }>('/api/volunteers/available', { query: { donationId } }),
  assign: (donationId: string, volunteerId: string) =>
    api<{ delivery: Delivery }>('/api/deliveries', { method: 'POST', body: { donationId, volunteerId } }),
  reassign: (deliveryId: string, volunteerId: string) =>
    api<{ delivery: Delivery }>(`/api/deliveries/${deliveryId}/reassign`, { method: 'POST', body: { volunteerId } }),
  /** Strict body: only `to` (ACCEPTED → CANCELLED, COMPLETED → AVAILABLE); the action is audited server-side. */
  overrideDonation: (donationId: string, to: Extract<DonationStatus, 'CANCELLED' | 'AVAILABLE'>) =>
    api<{ donation: Donation }>(`/api/donations/${donationId}/override`, { method: 'POST', body: { to } }),
  monitoring: () => api<Monitoring>('/api/admin/monitoring'),

  incidents: (query: { type?: IncidentType; status?: IncidentStatus; page?: number }) =>
    api<Page<Incident>>('/api/admin/incidents', { query: { ...query, limit: 25 } }),
  updateIncident: (id: string, input: { status: Exclude<IncidentStatus, 'OPEN'>; resolution?: string; suspendSubject?: boolean }) =>
    api<{ incident: Incident }>(`/api/admin/incidents/${id}`, { method: 'PUT', body: input }),

  settings: () => api<{ settings: SettingView[] }>('/api/admin/settings'),
  updateSettings: (values: Record<string, unknown>) => api<{ settings: SettingView[] }>('/api/admin/settings', { method: 'PUT', body: values }),

  auditLogs: (query: Query) => api<Page<AuditLogEntry>>('/api/admin/audit-logs', { query: { limit: 25, ...query } }),
};
