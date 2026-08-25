export type SigningDiscoveryWarningCode =
  | 'PROFILE_DECODE_FAILED'
  | 'PROFILE_INVALID'
  | 'PROFILE_SCAN_TRUNCATED'
  | 'PROFILE_IMPORT_CLEANUP_FAILED'
  | 'CERTIFICATE_INVALID'
  | 'IDENTITY_LOOKUP_FAILED';

export interface SigningDiscoveryWarning {
  code: SigningDiscoveryWarningCode;
  message: string;
}

export type SigningCertificateKind = 'distribution' | 'development' | 'other';

export interface SigningCertificateCandidate {
  name: string;
  sha1Fingerprint: string;
  kind: SigningCertificateKind;
}

export interface SigningProfileCandidate {
  profileName: string;
  uuid: string;
  teamId: string;
  teamName: string | null;
  expiresAt: string;
  certificateCandidates: SigningCertificateCandidate[];
  recommendedCertificate: SigningCertificateCandidate | null;
  warnings: SigningDiscoveryWarning[];
}

export interface SigningDiscoveryResult {
  bundleId: string;
  profiles: SigningProfileCandidate[];
  warnings: SigningDiscoveryWarning[];
}

export interface SigningProfileImportResult extends SigningDiscoveryResult {
  importedProfileUuid: string;
}
