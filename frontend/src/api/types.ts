export type VerificationStatus = 'PENDING' | 'UNDER_REVIEW' | 'VERIFIED' | 'REJECTED';

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

export interface OrganizationsPage {
  items: Organization[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}
