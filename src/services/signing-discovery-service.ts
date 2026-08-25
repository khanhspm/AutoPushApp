import { execFile } from 'node:child_process';
import { randomUUID, X509Certificate } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parsePlist } from 'plist';

import type {
  SigningCertificateCandidate,
  SigningCertificateKind,
  SigningDiscoveryResult,
  SigningDiscoveryWarning,
  SigningDiscoveryWarningCode,
  SigningProfileCandidate,
  SigningProfileImportResult,
} from '../domain/signing';
import { AppError } from '../http/errors';

const profileDirectoryParts = ['Library', 'MobileDevice', 'Provisioning Profiles'];
const securityPath = '/usr/bin/security';
const commandTimeoutMs = 10_000;
const commandMaxBuffer = 4 * 1024 * 1024;
const profileConcurrency = 4;
const maxInstalledProfiles = 500;
export const maxProfileImportBytes = 2 * 1024 * 1024;
const sha1Pattern = /^[0-9A-F]{40}$/;
const teamIdPattern = /^[A-Z0-9]{10}$/;
const uuidPattern = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;
const concreteBundleIdPattern = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;

const warningMessages: Record<SigningDiscoveryWarningCode, string> = {
  PROFILE_DECODE_FAILED: 'One or more provisioning profiles could not be decoded.',
  PROFILE_INVALID: 'One or more provisioning profiles contained invalid signing metadata.',
  PROFILE_SCAN_TRUNCATED: 'Only the first 500 installed provisioning profiles were inspected.',
  PROFILE_IMPORT_CLEANUP_FAILED: 'The profile was imported, but a temporary file could not be removed.',
  CERTIFICATE_INVALID: 'A developer certificate in this profile could not be read.',
  IDENTITY_LOOKUP_FAILED: 'Installed code-signing identities could not be inspected.',
};

export interface SigningDiscoveryDirectoryEntry {
  name: string;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface SigningDiscoveryFileSystem {
  readdir(
    directoryPath: string,
    options: { withFileTypes: true },
  ): Promise<readonly SigningDiscoveryDirectoryEntry[]>;
  mkdir?(directoryPath: string, options: { recursive: true; mode: number }): Promise<unknown>;
  lstat?(filePath: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  open?(filePath: string, flags: 'wx', mode: number): Promise<SigningImportFileHandle>;
  link?(existingPath: string, newPath: string): Promise<void>;
  readFile?(filePath: string): Promise<Buffer>;
  unlink?(filePath: string): Promise<void>;
}

export interface SigningImportFileHandle {
  writeFile(data: Buffer): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface SigningCommandOptions {
  stdin?: string;
  timeoutMs: number;
  maxBuffer: number;
}

export interface SigningCommandResult {
  stdout: string;
}

export interface SigningCommandRunner {
  run(command: string, args: readonly string[], options: SigningCommandOptions): Promise<SigningCommandResult>;
}

export interface SigningDiscoveryGateway {
  discover(bundleId: string): Promise<SigningDiscoveryResult>;
  importProfile(profileData: Buffer, expectedBundleId?: string): Promise<SigningProfileImportResult>;
}

export interface SigningDiscoveryDependencies {
  platform?: NodeJS.Platform;
  homeDirectory?: string;
  fileSystem?: SigningDiscoveryFileSystem;
  commandRunner?: SigningCommandRunner;
  now?: () => Date;
}

interface ParsedProfile {
  profile: Omit<SigningProfileCandidate, 'certificateCandidates' | 'recommendedCertificate'>;
  certificateFingerprints: Set<string>;
}

interface ParsedProfileMetadata extends ParsedProfile {
  bundleId: string | null;
  expirationTime: number;
  isAdHoc: boolean;
}

type ProfileMetadataParseResult =
  | { status: 'valid'; metadata: ParsedProfileMetadata }
  | { status: 'invalid' };

type ProfileEligibilityResult =
  | { status: 'eligible'; bundleId: string }
  | { status: 'ineligible'; reason: 'BUNDLE_ID_NOT_CONCRETE' | 'NOT_AD_HOC' | 'EXPIRED' | 'BUNDLE_ID_MISMATCH' };

interface DecodeResult {
  parsedProfile: ParsedProfile | null;
  warningCode?: SigningDiscoveryWarningCode;
}

type ProfileParseResult =
  | { status: 'eligible'; parsedProfile: ParsedProfile }
  | { status: 'excluded' }
  | { status: 'invalid' };

const nodeFileSystem: SigningDiscoveryFileSystem = {
  async readdir(directoryPath, options) {
    return fs.readdir(directoryPath, options);
  },
  async mkdir(directoryPath, options) {
    return fs.mkdir(directoryPath, options);
  },
  async lstat(filePath) {
    return fs.lstat(filePath);
  },
  async open(filePath, flags, mode) {
    return fs.open(filePath, flags, mode);
  },
  async link(existingPath, newPath) {
    return fs.link(existingPath, newPath);
  },
  async readFile(filePath) {
    return fs.readFile(filePath);
  },
  async unlink(filePath) {
    return fs.unlink(filePath);
  },
};

export class ExecFileCommandRunner implements SigningCommandRunner {
  run(command: string, args: readonly string[], options: SigningCommandOptions): Promise<SigningCommandResult> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        command,
        [...args],
        {
          encoding: 'utf8',
          maxBuffer: options.maxBuffer,
          shell: false,
          timeout: options.timeoutMs,
          windowsHide: true,
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout });
        },
      );
      if (child.stdin) {
        child.stdin.on('error', (error) => {
          if (errorCode(error) !== 'EPIPE') reject(error);
        });
        try {
          child.stdin.end(options.stdin);
        } catch (error) {
          if (errorCode(error) !== 'EPIPE') reject(error);
        }
      }
    });
  }
}

function warning(code: SigningDiscoveryWarningCode): SigningDiscoveryWarning {
  return { code, message: warningMessages[code] };
}

function addWarning(warnings: Map<SigningDiscoveryWarningCode, SigningDiscoveryWarning>, code: SigningDiscoveryWarningCode): void {
  if (!warnings.has(code)) warnings.set(code, warning(code));
}

const warningOrder: readonly SigningDiscoveryWarningCode[] = [
  'PROFILE_SCAN_TRUNCATED',
  'PROFILE_IMPORT_CLEANUP_FAILED',
  'PROFILE_DECODE_FAILED',
  'PROFILE_INVALID',
  'CERTIFICATE_INVALID',
  'IDENTITY_LOOKUP_FAILED',
];

function orderedWarnings(
  warnings: ReadonlyMap<SigningDiscoveryWarningCode, SigningDiscoveryWarning>,
): SigningDiscoveryWarning[] {
  return warningOrder.flatMap((code) => warnings.get(code) ?? []);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown, maxLength = 255): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

function certificateData(value: unknown): Buffer | null {
  if (Buffer.isBuffer(value)) {
    return value.length > 0 && value.length <= commandMaxBuffer ? value : null;
  }
  if (value instanceof Uint8Array) {
    return value.byteLength > 0 && value.byteLength <= commandMaxBuffer ? Buffer.from(value) : null;
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > commandMaxBuffer) return null;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return null;

  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || decoded.toString('base64') !== value) return null;
  return decoded;
}

function normalizeFingerprint(value: string): string | null {
  const normalized = value.replaceAll(':', '').trim().toUpperCase();
  return sha1Pattern.test(normalized) ? normalized : null;
}

function certificateFingerprint(value: unknown): string | null {
  const der = certificateData(value);
  if (!der) return null;

  try {
    return normalizeFingerprint(new X509Certificate(der).fingerprint);
  } catch {
    return null;
  }
}

function profileExpiration(value: unknown): Date | null {
  const expiration = value instanceof Date
    ? value
    : typeof value === 'string'
      ? new Date(value)
      : null;
  return expiration && !Number.isNaN(expiration.getTime()) ? expiration : null;
}

function profileBundleId(entitlements: Record<string, unknown>): string | null {
  const applicationIdentifier = nonEmptyString(
    entitlements['application-identifier'] ?? entitlements['com.apple.application-identifier'],
    512,
  );
  if (!applicationIdentifier || applicationIdentifier.includes('*')) return null;
  const separator = applicationIdentifier.indexOf('.');
  if (separator <= 0 || separator === applicationIdentifier.length - 1) return null;
  return applicationIdentifier.slice(separator + 1);
}

function parseProfileMetadata(value: unknown): ProfileMetadataParseResult {
  if (!isRecord(value)) return { status: 'invalid' };

  const profileName = nonEmptyString(value.Name);
  const uuid = nonEmptyString(value.UUID, 64);
  const expiration = profileExpiration(value.ExpirationDate);
  const teamName = value.TeamName === undefined ? null : nonEmptyString(value.TeamName);
  const teamIdentifiers = Array.isArray(value.TeamIdentifier) ? value.TeamIdentifier : null;
  const teamId = teamIdentifiers
    ?.map((candidate) => nonEmptyString(candidate, 32))
    .find((candidate): candidate is string => Boolean(candidate && teamIdPattern.test(candidate))) ?? null;
  const entitlements = isRecord(value.Entitlements) ? value.Entitlements : null;
  const developerCertificates = Array.isArray(value.DeveloperCertificates) ? value.DeveloperCertificates : null;

  if (!profileName || !uuid || !uuidPattern.test(uuid) || !expiration || !teamId || !entitlements || !developerCertificates) {
    return { status: 'invalid' };
  }

  const devices = value.ProvisionedDevices;
  const isAdHoc = Array.isArray(devices)
    && devices.length > 0
    && entitlements['get-task-allow'] === false
    && value.ProvisionsAllDevices !== true;
  const certificateFingerprints = new Set<string>();
  const profileWarnings: SigningDiscoveryWarning[] = [];
  for (const certificate of developerCertificates) {
    const fingerprint = certificateFingerprint(certificate);
    if (fingerprint) {
      certificateFingerprints.add(fingerprint);
    } else if (!profileWarnings.some((item) => item.code === 'CERTIFICATE_INVALID')) {
      profileWarnings.push(warning('CERTIFICATE_INVALID'));
    }
  }

  return {
    status: 'valid',
    metadata: {
      bundleId: profileBundleId(entitlements),
      expirationTime: expiration.getTime(),
      isAdHoc,
      profile: {
        profileName,
        uuid: uuid.toUpperCase(),
        teamId,
        teamName,
        expiresAt: expiration.toISOString(),
        warnings: profileWarnings,
      },
      certificateFingerprints,
    },
  };
}

function profileEligibility(
  metadata: ParsedProfileMetadata,
  now: Date,
  expectedBundleId?: string,
  requireConcreteBundleId = false,
): ProfileEligibilityResult {
  if (!metadata.bundleId || (requireConcreteBundleId && !concreteBundleIdPattern.test(metadata.bundleId))) {
    return { status: 'ineligible', reason: 'BUNDLE_ID_NOT_CONCRETE' };
  }
  if (!metadata.isAdHoc) return { status: 'ineligible', reason: 'NOT_AD_HOC' };
  if (metadata.expirationTime <= now.getTime()) return { status: 'ineligible', reason: 'EXPIRED' };
  if (expectedBundleId !== undefined && metadata.bundleId !== expectedBundleId) {
    return { status: 'ineligible', reason: 'BUNDLE_ID_MISMATCH' };
  }
  return { status: 'eligible', bundleId: metadata.bundleId };
}

function parseProfile(value: unknown, bundleId: string, now: Date): ProfileParseResult {
  const result = parseProfileMetadata(value);
  if (result.status === 'invalid') return result;

  const { metadata } = result;
  if (profileEligibility(metadata, now, bundleId).status === 'ineligible') {
    return { status: 'excluded' };
  }
  return {
    status: 'eligible',
    parsedProfile: {
      profile: metadata.profile,
      certificateFingerprints: metadata.certificateFingerprints,
    },
  };
}

function certificateKind(name: string): SigningCertificateKind {
  if (/\bdistribution\b/i.test(name)) return 'distribution';
  if (/\bdevelopment\b/i.test(name)) return 'development';
  return 'other';
}

function parseIdentities(output: string): Map<string, SigningCertificateCandidate> {
  const identities = new Map<string, SigningCertificateCandidate>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*\d+\)\s+([0-9A-Fa-f]{40})\s+"([^"\r\n]+)"\s*$/.exec(line);
    if (!match) continue;
    const fingerprint = normalizeFingerprint(match[1]);
    const name = nonEmptyString(match[2], 500);
    if (!fingerprint || !name || identities.has(fingerprint)) continue;
    identities.set(fingerprint, {
      name,
      sha1Fingerprint: fingerprint,
      kind: certificateKind(name),
    });
  }
  return identities;
}

function buildProfileCandidate(
  parsedProfile: ParsedProfile,
  identities: ReadonlyMap<string, SigningCertificateCandidate>,
): SigningProfileCandidate {
  const certificateCandidates = [...parsedProfile.certificateFingerprints]
    .flatMap((fingerprint) => identities.get(fingerprint) ?? [])
    .sort((left, right) => compareText(left.name, right.name) || compareText(left.sha1Fingerprint, right.sha1Fingerprint));
  const distributionCandidates = certificateCandidates.filter((candidate) => candidate.kind === 'distribution');
  return {
    ...parsedProfile.profile,
    certificateCandidates,
    recommendedCertificate: distributionCandidates.length === 1 ? distributionCandidates[0] : null,
  };
}

function parsedProfileFromMetadata(metadata: ParsedProfileMetadata): ParsedProfile {
  return {
    profile: metadata.profile,
    certificateFingerprints: metadata.certificateFingerprints,
  };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapValue: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapValue(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

type SigningImportFileSystem = SigningDiscoveryFileSystem & Required<Pick<
  SigningDiscoveryFileSystem,
  'mkdir' | 'lstat' | 'open' | 'link' | 'readFile' | 'unlink'
>>;

function supportsProfileImport(fileSystem: SigningDiscoveryFileSystem): fileSystem is SigningImportFileSystem {
  return typeof fileSystem.mkdir === 'function'
    && typeof fileSystem.lstat === 'function'
    && typeof fileSystem.open === 'function'
    && typeof fileSystem.link === 'function'
    && typeof fileSystem.readFile === 'function'
    && typeof fileSystem.unlink === 'function';
}

function profileImportFailed(): AppError {
  return new AppError(503, 'SIGNING_PROFILE_IMPORT_FAILED', 'Unable to import the provisioning profile');
}

function profileImportConflict(): AppError {
  return new AppError(
    409,
    'SIGNING_PROFILE_IMPORT_CONFLICT',
    'A provisioning profile with this UUID already exists and could not be verified',
  );
}

export class SigningDiscoveryService implements SigningDiscoveryGateway {
  private readonly platform: NodeJS.Platform;
  private readonly homeDirectory: string;
  private readonly fileSystem: SigningDiscoveryFileSystem;
  private readonly commandRunner: SigningCommandRunner;
  private readonly now: () => Date;
  private discoveryTail: Promise<void> = Promise.resolve();

  constructor(dependencies: SigningDiscoveryDependencies = {}) {
    this.platform = dependencies.platform ?? process.platform;
    this.homeDirectory = dependencies.homeDirectory ?? os.homedir();
    this.fileSystem = dependencies.fileSystem ?? nodeFileSystem;
    this.commandRunner = dependencies.commandRunner ?? new ExecFileCommandRunner();
    this.now = dependencies.now ?? (() => new Date());
  }

  private async inspectIdentities(
    warnings: Map<SigningDiscoveryWarningCode, SigningDiscoveryWarning>,
  ): Promise<Map<string, SigningCertificateCandidate>> {
    try {
      const result = await this.commandRunner.run(
        securityPath,
        ['find-identity', '-v', '-p', 'codesigning'],
        { timeoutMs: commandTimeoutMs, maxBuffer: commandMaxBuffer },
      );
      return parseIdentities(result.stdout);
    } catch {
      addWarning(warnings, 'IDENTITY_LOOKUP_FAILED');
      return new Map();
    }
  }

  private async fallbackDiscovery(
    bundleId: string,
    metadata: ParsedProfileMetadata,
    inheritedWarnings: readonly SigningDiscoveryWarning[] = [],
  ): Promise<SigningDiscoveryResult> {
    const warnings = new Map<SigningDiscoveryWarningCode, SigningDiscoveryWarning>();
    for (const inheritedWarning of inheritedWarnings) {
      if (inheritedWarning.code !== 'IDENTITY_LOOKUP_FAILED') {
        warnings.set(inheritedWarning.code, inheritedWarning);
      }
    }
    const identities = await this.inspectIdentities(warnings);
    return {
      bundleId,
      profiles: [buildProfileCandidate(parsedProfileFromMetadata(metadata), identities)],
      warnings: orderedWarnings(warnings),
    };
  }

  async importProfile(profileData: Buffer, expectedBundleId?: string): Promise<SigningProfileImportResult> {
    if (this.platform !== 'darwin') {
      throw new AppError(501, 'SIGNING_PROFILE_IMPORT_UNSUPPORTED', 'Provisioning profile import is available only on macOS');
    }
    if (profileData.length === 0) {
      throw new AppError(400, 'SIGNING_PROFILE_INVALID', 'The provisioning profile is invalid');
    }
    if (profileData.length > maxProfileImportBytes) {
      throw new AppError(413, 'SIGNING_PROFILE_TOO_LARGE', 'The provisioning profile exceeds the 2 MiB limit');
    }
    if (!supportsProfileImport(this.fileSystem)) throw profileImportFailed();

    const importFileSystem = this.fileSystem;
    const profileDirectory = path.join(this.homeDirectory, ...profileDirectoryParts);
    let stagingPath: string | null = null;
    let stagingCreated = false;
    let stagingHandle: SigningImportFileHandle | null = null;
    let cleanupFailed = false;
    let operationError: AppError | null = null;
    let importResult: SigningProfileImportResult | null = null;

    try {
      let safeDirectoryPath = this.homeDirectory;
      for (const directoryPart of profileDirectoryParts) {
        safeDirectoryPath = path.join(safeDirectoryPath, directoryPart);
        await importFileSystem.mkdir(safeDirectoryPath, { recursive: true, mode: 0o700 });
        const directoryStat = await importFileSystem.lstat(safeDirectoryPath);
        if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw profileImportFailed();
      }

      stagingPath = path.join(profileDirectory, `.autopush-${randomUUID()}.mobileprovision.tmp`);
      stagingHandle = await importFileSystem.open(stagingPath, 'wx', 0o600);
      stagingCreated = true;
      try {
        await stagingHandle.writeFile(profileData);
        await stagingHandle.sync();
      } finally {
        await stagingHandle.close();
        stagingHandle = null;
      }

      let parsedValue: unknown;
      try {
        const { stdout: xml } = await this.commandRunner.run(
          securityPath,
          ['cms', '-D', '-i', stagingPath],
          { timeoutMs: commandTimeoutMs, maxBuffer: commandMaxBuffer },
        );
        parsedValue = parsePlist(xml);
      } catch {
        throw new AppError(400, 'SIGNING_PROFILE_INVALID', 'The provisioning profile is invalid');
      }
      const parsed = parseProfileMetadata(parsedValue);
      if (parsed.status === 'invalid') {
        throw new AppError(400, 'SIGNING_PROFILE_INVALID', 'The provisioning profile is invalid');
      }

      const { metadata } = parsed;
      const eligibility = profileEligibility(metadata, this.now(), expectedBundleId, true);
      if (eligibility.status === 'ineligible') {
        switch (eligibility.reason) {
          case 'BUNDLE_ID_NOT_CONCRETE':
            throw new AppError(400, 'SIGNING_PROFILE_INVALID', 'The provisioning profile must contain a concrete bundle identifier');
          case 'NOT_AD_HOC':
            throw new AppError(400, 'SIGNING_PROFILE_NOT_AD_HOC', 'The provisioning profile is not an Ad Hoc distribution profile');
          case 'EXPIRED':
            throw new AppError(400, 'SIGNING_PROFILE_EXPIRED', 'The provisioning profile has expired');
          case 'BUNDLE_ID_MISMATCH':
            throw new AppError(400, 'SIGNING_PROFILE_BUNDLE_ID_MISMATCH', 'The provisioning profile bundle identifier does not match the expected bundle identifier');
        }
      }
      const bundleId = eligibility.bundleId;

      const destinationPath = path.join(profileDirectory, `${metadata.profile.uuid}.mobileprovision`);
      let destinationAlreadyExists = false;
      try {
        await importFileSystem.link(stagingPath, destinationPath);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw profileImportFailed();
        destinationAlreadyExists = true;
        let existingData: Buffer;
        try {
          existingData = await importFileSystem.readFile(destinationPath);
        } catch {
          throw profileImportConflict();
        }
        if (!existingData.equals(profileData)) throw profileImportConflict();
      }

      let discovery: SigningDiscoveryResult | null = null;
      try {
        discovery = await this.discover(bundleId);
      } catch {
        // A byte-identical installed profile can still be represented safely from
        // the already validated upload when the broader directory scan fails.
      }

      const importedProfile = discovery?.profiles.find((profile) => profile.uuid === metadata.profile.uuid);
      if (importedProfile && discovery) {
        if (destinationAlreadyExists) {
          let currentData: Buffer;
          try {
            currentData = await importFileSystem.readFile(destinationPath);
          } catch {
            throw profileImportConflict();
          }
          if (!currentData.equals(profileData)) throw profileImportConflict();
        }
        importResult = { ...discovery, importedProfileUuid: metadata.profile.uuid };
      } else {
        if (destinationAlreadyExists) {
          let currentData: Buffer;
          try {
            currentData = await importFileSystem.readFile(destinationPath);
          } catch {
            throw profileImportConflict();
          }
          if (!currentData.equals(profileData)) throw profileImportConflict();
        }
        const fallback = await this.fallbackDiscovery(bundleId, metadata, discovery?.warnings);
        importResult = { ...fallback, importedProfileUuid: metadata.profile.uuid };
      }
    } catch (error) {
      operationError = error instanceof AppError ? error : profileImportFailed();
    } finally {
      if (stagingHandle) {
        try {
          await stagingHandle.close();
        } catch {
          cleanupFailed = true;
        }
      }
      if (stagingCreated && stagingPath) {
        try {
          await importFileSystem.unlink(stagingPath);
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') cleanupFailed = true;
        }
      }
    }

    if (operationError) throw operationError;
    if (!importResult) throw profileImportFailed();
    if (cleanupFailed && !importResult.warnings.some((item) => item.code === 'PROFILE_IMPORT_CLEANUP_FAILED')) {
      importResult = { ...importResult, warnings: [...importResult.warnings, warning('PROFILE_IMPORT_CLEANUP_FAILED')] };
    }
    return importResult;
  }

  async discover(bundleId: string): Promise<SigningDiscoveryResult> {
    const operation = this.discoveryTail.then(() => this.discoverSerialized(bundleId));
    this.discoveryTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async discoverSerialized(bundleId: string): Promise<SigningDiscoveryResult> {
    if (this.platform !== 'darwin') {
      throw new AppError(501, 'SIGNING_DISCOVERY_UNSUPPORTED', 'Signing discovery is available only on macOS');
    }

    const profileDirectory = path.join(this.homeDirectory, ...profileDirectoryParts);
    let entries: readonly SigningDiscoveryDirectoryEntry[];
    try {
      entries = await this.fileSystem.readdir(profileDirectory, { withFileTypes: true });
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { bundleId, profiles: [], warnings: [] };
      throw new AppError(503, 'SIGNING_DISCOVERY_FAILED', 'Unable to inspect installed signing profiles');
    }

    const profileEntries = entries
      .filter((entry) => entry.name.endsWith('.mobileprovision') && entry.isFile() && !entry.isSymbolicLink())
      .sort((left, right) => compareText(left.name, right.name));
    const warnings = new Map<SigningDiscoveryWarningCode, SigningDiscoveryWarning>();
    if (profileEntries.length > maxInstalledProfiles) addWarning(warnings, 'PROFILE_SCAN_TRUNCATED');
    const profilePaths = profileEntries
      .slice(0, maxInstalledProfiles)
      .map((entry) => path.join(profileDirectory, entry.name));
    if (profilePaths.length === 0) return { bundleId, profiles: [], warnings: orderedWarnings(warnings) };

    const discoveryTime = this.now();
    const decoded = await mapWithConcurrency(profilePaths, profileConcurrency, async (profilePath): Promise<DecodeResult> => {
      let xml: string;
      try {
        ({ stdout: xml } = await this.commandRunner.run(
          securityPath,
          ['cms', '-D', '-i', profilePath],
          { timeoutMs: commandTimeoutMs, maxBuffer: commandMaxBuffer },
        ));
      } catch {
        return { parsedProfile: null, warningCode: 'PROFILE_DECODE_FAILED' };
      }

      let parsedValue: unknown;
      try {
        parsedValue = parsePlist(xml);
      } catch {
        return { parsedProfile: null, warningCode: 'PROFILE_DECODE_FAILED' };
      }

      try {
        const parsed = parseProfile(parsedValue, bundleId, discoveryTime);
        if (parsed.status === 'eligible') return { parsedProfile: parsed.parsedProfile };
        if (parsed.status === 'excluded') return { parsedProfile: null };
        return { parsedProfile: null, warningCode: 'PROFILE_INVALID' };
      } catch {
        return { parsedProfile: null, warningCode: 'PROFILE_INVALID' };
      }
    });

    const eligibleProfiles: ParsedProfile[] = [];
    for (const result of decoded) {
      if (result.warningCode) addWarning(warnings, result.warningCode);
      if (result.parsedProfile) eligibleProfiles.push(result.parsedProfile);
    }
    if (eligibleProfiles.length === 0) {
      return { bundleId, profiles: [], warnings: orderedWarnings(warnings) };
    }

    const identities = await this.inspectIdentities(warnings);
    const profiles = eligibleProfiles.map((parsedProfile) => buildProfileCandidate(parsedProfile, identities));

    profiles.sort((left, right) => (
      Date.parse(right.expiresAt) - Date.parse(left.expiresAt)
      || compareText(left.profileName, right.profileName)
      || compareText(left.uuid, right.uuid)
    ));

    const seenUuids = new Set<string>();
    const deduplicatedProfiles = profiles.filter((profile) => {
      if (seenUuids.has(profile.uuid)) return false;
      seenUuids.add(profile.uuid);
      return true;
    });

    return { bundleId, profiles: deduplicatedProfiles, warnings: orderedWarnings(warnings) };
  }
}
