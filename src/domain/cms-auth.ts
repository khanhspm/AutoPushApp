export type CmsAccountStatus = 'active' | 'disabled';

export interface CmsAccount {
  id: string;
  email: string;
  status: CmsAccountStatus;
  acceptedAt: string;
  createdAt: string;
  updatedAt: string;
}

export type CmsInvitationStatus = 'pending' | 'accepted' | 'expired' | 'revoked';

export interface CmsInvitation {
  id: string;
  email: string;
  status: CmsInvitationStatus;
  expiresAt: string;
  sentAt?: string;
  acceptedAt?: string;
  createdAt: string;
}

export interface CmsAccessOverview {
  accounts: CmsAccount[];
  invitations: CmsInvitation[];
}

export interface CmsMemberPrincipal {
  authMethod: 'member-session';
  role: 'member';
  subject: string;
  accountId: string;
  email: string;
}

export interface CmsAdminPrincipal {
  authMethod: 'admin-token';
  role: 'admin';
  subject: 'static-admin';
}

export type CmsPrincipal = CmsAdminPrincipal | CmsMemberPrincipal;

export interface CmsSessionResult {
  rawToken: string;
  expiresAt: string;
  account: CmsAccount;
}
