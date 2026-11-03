// Response shapes of the FWRP API (dates arrive as ISO strings).

export type Role = 'PROVIDER' | 'RECIPIENT' | 'VOLUNTEER' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED';
export type VerificationStatus = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';
export type OrganizationType =
  | 'RESTAURANT'
  | 'HOTEL'
  | 'CAFETERIA'
  | 'SUPERMARKET'
  | 'EVENT_ORGANIZER'
  | 'NGO'
  | 'SHELTER'
  | 'COMMUNITY_KITCHEN'
  | 'FOOD_BANK'
  | 'OTHER';

export type DonationStatus =
  | 'DRAFT'
  | 'AVAILABLE'
  | 'MATCHED'
  | 'ACCEPTED'
  | 'PICKUP_ASSIGNED'
  | 'PICKED_UP'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'COMPLETED'
  | 'EXPIRED'
  | 'CANCELLED';

export type DeliveryStatus = 'ASSIGNED' | 'ACCEPTED' | 'AT_PICKUP' | 'PICKED_UP' | 'IN_TRANSIT' | 'DELIVERED' | 'CONFIRMED';
export type MatchStatus = 'RECOMMENDED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RequirementStatus = 'OPEN' | 'PARTIALLY_FULFILLED' | 'FULFILLED' | 'EXPIRED' | 'CANCELLED';

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// ---------------------------------------------------------------- users / orgs

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: Role;
  organizationId: string | null;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationSummary {
  id: string;
  name: string;
  type: OrganizationType;
  address: string;
  verificationStatus: VerificationStatus;
}

export interface Profile {
  user: User;
  organization: OrganizationSummary | null;
}

export interface Organization {
  id: string;
  name: string;
  type: string;
  address: string;
  latitude: number;
  longitude: number;
  contactInformation: string | null;
  verificationStatus: VerificationStatus;
  createdAt: string;
  updatedAt: string;
}

export type OrganizationsPage = Page<Organization>;

// ---------------------------------------------------------------- donations

export interface Category {
  id: string;
  name: string;
  slug: string;
}

export interface Donation {
  id: string;
  providerId: string;
  foodName: string;
  category: string;
  foodType: string;
  quantity: number;
  unit: string;
  availableFrom: string;
  availableUntil: string;
  pickupLocation: string;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  storageRequirement: string | null;
  description: string | null;
  status: DonationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DonationTimelineEvent {
  action: string;
  timestamp: string;
  oldValue: string | null;
  newValue: string | null;
}

export interface DonationHistoryItem extends Donation {
  timeline: DonationTimelineEvent[];
}

export interface DonationDetail extends Donation {
  provider: { id: string; name: string; organization: { id: string; name: string; verificationStatus: string } | null };
  time_remaining: number;
}

export interface DonationInput {
  foodName: string;
  category: string;
  foodType: string;
  quantity: number;
  unit: string;
  availableFrom: string;
  availableUntil: string;
  pickupLocation: string;
  pickupLatitude?: number;
  pickupLongitude?: number;
  storageRequirement?: string;
  description?: string;
}

// ---------------------------------------------------------------- matches

export interface MatchSummary {
  id: string;
  matchingScore: number;
  distance: number;
  status: MatchStatus;
  createdAt: string;
  updatedAt: string;
  donation: {
    id: string;
    providerId: string;
    foodName: string;
    category: string;
    foodType: string;
    quantity: number;
    unit: string;
    availableFrom: string;
    availableUntil: string;
    pickupLocation: string;
    status: DonationStatus;
  };
  requirement: {
    id: string;
    organizationId: string;
    foodCategory: string;
    foodType: string;
    quantityRequired: number;
    quantityFulfilled: number;
    requiredBy: string;
    priority: Priority;
    location: string;
    status: RequirementStatus;
    organization: { id: string; name: string };
  };
}

// ---------------------------------------------------------------- deliveries

export interface Delivery {
  id: string;
  status: DeliveryStatus;
  needsReassignment: boolean;
  assignedAt: string;
  pickupTime: string | null;
  deliveryTime: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  handoverConfirmedAt: string | null;
  confirmedAt: string | null;
  quantityReceived: number | null;
  receiverName: string | null;
  proofOfDelivery: string | null;
  notes: string | null;
  volunteer: { id: string; name: string; phone: string };
  donation: {
    id: string;
    foodName: string;
    category: string;
    foodType: string;
    quantity: number;
    unit: string;
    availableUntil: string;
    storageRequirement: string | null;
    status: DonationStatus;
    committedQuantity: number;
  };
  pickup: {
    location: string;
    latitude: number | null;
    longitude: number | null;
    provider: { name: string; phone: string; organization: string | null; contact: string | null };
  };
  dropoff: {
    location: string;
    latitude: number | null;
    longitude: number | null;
    requirementId: string | null;
    organization: { id: string; name: string; contact: string | null } | null;
  };
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------- notifications

export type NotificationType =
  | 'DONATION_CREATED'
  | 'DONATION_MATCHED'
  | 'DONATION_ACCEPTED'
  | 'PICKUP_ASSIGNED'
  | 'PICKUP_REMINDER'
  | 'DELIVERY_DELAYED'
  | 'EXPIRY_WARNING'
  | 'DONATION_EXPIRED'
  | 'DELIVERY_COMPLETED'
  | 'CONFIRMATION_PENDING'
  | 'ORGANIZATION_VERIFIED'
  | 'ORGANIZATION_REJECTED'
  | 'INCIDENT_UPDATED';

export interface AppNotification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
  entityType: string | null;
  entityId: string | null;
}

// ---------------------------------------------------------------- analytics

export interface QuantityByUnit {
  unit: string;
  quantity: number;
}

export interface ProviderDashboard {
  role: 'PROVIDER';
  activeDonations: number;
  completedDonations: number;
  expiredDonations: number;
  successfulRedistributions: number;
  quantityDonated: QuantityByUnit[];
  quantityRedistributed: QuantityByUnit[];
  fulfillmentRate: number | null;
  recentActivity: Array<{ donationId: string; foodName: string; status: DonationStatus; updatedAt: string }>;
}

// ---------------------------------------------------------------- incidents

export type IncidentType = 'ACCOUNT_REPORT' | 'DISPUTE';
export type IncidentStatus = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'DISMISSED';

export interface Incident {
  id: string;
  type: IncidentType;
  status: IncidentStatus;
  reason: string;
  description: string;
  donationId: string | null;
  deliveryId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  reporter: { id: string; name: string; role: Role };
  subjectUser: { id: string; name: string; role: Role; status: UserStatus } | null;
  resolvedBy: { id: string; name: string } | null;
}

// ---------------------------------------------------------------- requirements (snake_case API)

export interface Requirement {
  id: string;
  organization_id: string;
  food_category: string;
  food_type: string;
  quantity_required: number;
  quantity_fulfilled: number;
  required_by: string;
  priority: Priority;
  location: string;
  status: RequirementStatus;
  created_at: string;
  updated_at: string;
}

export interface RequirementInput {
  food_category: string;
  food_type: string;
  quantity_required: number;
  required_by: string;
  priority: Priority;
  location: string;
}

// ---------------------------------------------------------------- dashboards

export interface RecipientDashboard {
  role: 'RECIPIENT';
  openRequirements: number;
  fulfilledRequirements: number;
  availableDonations: number;
  recommendedMatches: number;
  acceptedDonations: number;
  pendingDeliveries: number;
  awaitingConfirmation: number;
  history: { completedDeliveries: number; quantityReceived: QuantityByUnit[]; totalRequirements: number };
}

export interface VolunteerDashboard {
  role: 'VOLUNTEER';
  activeDeliveries: number;
  completedDeliveries: number;
  upcomingAvailabilityWindows: number;
  averagePickupMinutes: number | null;
}

export interface ImpactKpis {
  from: string | null;
  to: string | null;
  totalDonations: number;
  validDonations: number;
  completedDonations: number;
  expiredDonations: number;
  mealsRedistributed: number;
  weightRedistributedKg: number;
  redistributed: QuantityByUnit[];
  fulfillmentRate: number | null;
  expiryRate: number | null;
  averageMatchingMinutes: number | null;
  averagePickupMinutes: number | null;
  averageDeliveryMinutes: number | null;
}

export interface AdminDashboard {
  role: 'ADMIN';
  activeDonations: number;
  completedDonations: number;
  expiredDonations: number;
  pendingPickups: number;
  activeDeliveries: number;
  verifiedOrganizations: number;
  activeVolunteers: number;
  kpis: ImpactKpis;
}

export interface ReportParty {
  id: string;
  name: string;
  donations: number;
  completed: number;
  redistributed: QuantityByUnit[];
}

export interface Report {
  filters: Record<string, unknown>;
  generatedAt: string;
  summary: ImpactKpis & { cancelledDonations: number; byStatus: Partial<Record<DonationStatus, number>> };
  averageResponseMinutes: number | null;
  mostActiveDonors: ReportParty[];
  mostActiveRecipients: ReportParty[];
  failedDonations: Array<{ donationId: string; foodName: string; status: DonationStatus; provider: string; createdAt: string }>;
}

// ---------------------------------------------------------------- volunteers

export interface AvailabilityWindow {
  id: string;
  availableFrom: string;
  availableUntil: string;
}

export interface AvailableVolunteer {
  id: string;
  name: string;
  phone: string;
  windows: AvailabilityWindow[];
}

// ---------------------------------------------------------------- admin

export interface AdminUser extends Omit<User, 'organizationId'> {
  organization: { id: string; name: string; type: OrganizationType; verificationStatus: VerificationStatus } | null;
}

export interface PendingAssignments {
  awaitingVolunteer: Array<{
    donationId: string;
    foodName: string;
    quantity: number;
    unit: string;
    pickupLocation: string;
    availableUntil: string;
    recipientOrganization: string | null;
  }>;
  declined: Delivery[];
}

export interface MonitoringDelivery {
  id: string;
  status: DeliveryStatus;
  assignedAt: string;
  pickupTime: string | null;
  declinedAt: string | null;
  volunteer: { id: string; name: string; phone: string };
  donation: { id: string; foodName: string; availableUntil: string; pickupLocation: string };
}

export interface Monitoring {
  generatedAt: string;
  expiringUnclaimed: Array<{ id: string; foodName: string; quantity: number; unit: string; availableUntil: string; providerId: string }>;
  awaitingVolunteer: Array<{ id: string; foodName: string; quantity: number; unit: string; availableUntil: string }>;
  activeDeliveries: MonitoringDelivery[];
  delayedDeliveries: MonitoringDelivery[];
  openIncidents: number;
  pendingVerifications: number;
}

export interface AuditLogEntry {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValue: string | null;
  newValue: string | null;
  timestamp: string;
  user: { id: string; name: string; role: Role } | null;
}

export interface SettingView {
  key: string;
  value: unknown;
  default: unknown;
  description: string;
  overridden: boolean;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
}
