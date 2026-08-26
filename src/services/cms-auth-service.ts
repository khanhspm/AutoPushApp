import crypto from 'node:crypto';

import { z } from 'zod';

import type { CmsAccessOverview, CmsAccount, CmsAccountStatus, CmsMemberPrincipal, CmsSessionResult } from '../domain/cms-auth';
import { AppError } from '../http/errors';
import type { CmsAuthRepository } from '../repositories/cms-auth-repository';
import type { CmsMailGateway } from './cms-mail-service';

const COMPANY_DOMAIN = 'matechmobile.com';
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_COOLDOWN_MS = 60 * 1000;
const OTP_RATE_WINDOW_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 72 * 60 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const MAX_OTP_PER_EMAIL = 3;
const MAX_OTP_PER_IP = 10;

export interface CmsAuthServiceOptions {
  pepper: string;
  publicUrl: string;
  now?: () => Date;
  randomToken?: () => string;
  randomId?: () => string;
  otpGenerator?: () => string;
}

export class CmsAuthService {
  private readonly now: () => Date;
  private readonly randomToken: () => string;
  private readonly randomId: () => string;
  private readonly otpGenerator: () => string;

  constructor(
    private readonly repository: CmsAuthRepository,
    private readonly mail: CmsMailGateway,
    private readonly options: CmsAuthServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.randomToken = options.randomToken ?? (() => crypto.randomBytes(32).toString('base64url'));
    this.randomId = options.randomId ?? (() => crypto.randomUUID());
    this.otpGenerator = options.otpGenerator ?? (() => crypto.randomInt(0, 1_000_000).toString().padStart(6, '0'));
  }

  listAccess(): CmsAccessOverview {
    return this.repository.listAccess(this.now().toISOString());
  }

  async invite(emailInput: string): Promise<void> {
    const email = canonicalCompanyEmail(emailInput);
    if (this.repository.findAccountByEmail(email)) {
      throw new AppError(409, 'CMS_ACCOUNT_EXISTS', 'This email already has a CMS account');
    }
    await this.issueInvitation(email);
  }

  async resendInvitation(invitationId: string): Promise<void> {
    const now = this.now().toISOString();
    const invitation = this.repository.findInvitationById(invitationId, now);
    if (!invitation || invitation.status === 'accepted') {
      throw new AppError(404, 'INVITATION_NOT_FOUND', 'Invitation was not found');
    }
    if (this.repository.findAccountByEmail(invitation.email)) {
      throw new AppError(409, 'CMS_ACCOUNT_EXISTS', 'This email already has a CMS account');
    }
    await this.issueInvitation(invitation.email);
  }

  revokeInvitation(invitationId: string): void {
    if (!this.repository.revokeInvitation(invitationId, this.now().toISOString())) {
      throw new AppError(404, 'INVITATION_NOT_FOUND', 'Pending invitation was not found');
    }
  }

  acceptInvitation(rawToken: string): CmsAccount {
    const token = z.string().trim().min(32).max(500).parse(rawToken);
    const account = this.repository.acceptInvitation(
      this.hash(`invite:${token}`),
      this.randomId(),
      this.now().toISOString(),
    );
    if (!account) {
      throw new AppError(400, 'INVALID_OR_EXPIRED_INVITATION', 'Invitation is invalid, expired, or already used');
    }
    return account;
  }

  async requestOtp(emailInput: string, ipAddress: string): Promise<{ challengeId: string; expiresInSeconds: number; message: string }> {
    const email = canonicalCompanyEmail(emailInput);
    const now = this.now();
    const nowIso = now.toISOString();
    const windowStart = new Date(now.getTime() - OTP_RATE_WINDOW_MS).toISOString();
    const ipHash = this.hash(`ip:${ipAddress}`);
    const latest = this.repository.latestOtpCreatedAt(email);

    if (latest && now.getTime() - Date.parse(latest) < OTP_COOLDOWN_MS) {
      throw new AppError(429, 'OTP_COOLDOWN', 'Please wait before requesting another sign-in code');
    }
    if (this.repository.countOtpRequestsForEmail(email, windowStart) >= MAX_OTP_PER_EMAIL) {
      throw new AppError(429, 'OTP_RATE_LIMITED', 'Too many sign-in code requests');
    }
    if (this.repository.countOtpRequestsForIp(ipHash, windowStart) >= MAX_OTP_PER_IP) {
      throw new AppError(429, 'OTP_RATE_LIMITED', 'Too many sign-in code requests');
    }

    const account = this.repository.findAccountByEmail(email);
    const challengeId = this.randomId();
    const code = this.otpGenerator();
    const expiresAt = new Date(now.getTime() + OTP_TTL_MS).toISOString();
    this.repository.createOtpChallenge({
      id: challengeId,
      email,
      accountId: account?.status === 'active' ? account.id : undefined,
      codeHash: this.hash(`otp:${challengeId}:${email}:${code}`),
      ipHash,
      maxAttempts: MAX_OTP_ATTEMPTS,
      expiresAt,
      createdAt: nowIso,
    });

    if (account?.status === 'active') {
      try {
        await this.mail.sendOtp({ to: email, code, expiresAt });
      } catch {
        // Keep the public response identical for active and unknown addresses.
        this.repository.consumeOtpChallenge(challengeId, nowIso);
      }
    }

    return {
      challengeId,
      expiresInSeconds: OTP_TTL_MS / 1000,
      message: 'If this address has active CMS access, a sign-in code has been sent.',
    };
  }

  verifyOtp(challengeIdInput: string, codeInput: string): CmsSessionResult {
    const challengeId = z.string().uuid().parse(challengeIdInput);
    const code = z.string().regex(/^\d{6}$/).parse(codeInput);
    const challenge = this.repository.findOtpChallenge(challengeId);
    const now = this.now();
    const nowIso = now.toISOString();

    if (
      !challenge ||
      challenge.consumedAt ||
      challenge.expiresAt <= nowIso ||
      challenge.attemptCount >= challenge.maxAttempts ||
      !challenge.accountId
    ) {
      throw invalidOtpError();
    }

    const actualHash = this.hash(`otp:${challenge.id}:${challenge.email}:${code}`);
    if (!safeEqual(actualHash, challenge.codeHash)) {
      this.repository.recordOtpFailure(challenge.id, nowIso);
      throw invalidOtpError();
    }

    const account = this.repository.findAccountById(challenge.accountId);
    if (!account || account.status !== 'active') {
      throw invalidOtpError();
    }

    const rawToken = this.randomToken();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
    const created = this.repository.consumeOtpAndCreateSession({
      challengeId: challenge.id,
      sessionId: this.randomId(),
      tokenHash: this.hash(`session:${rawToken}`),
      createdAt: nowIso,
      expiresAt,
    });
    if (!created) throw invalidOtpError();

    return { rawToken, expiresAt, account };
  }

  authenticateSession(rawToken: string): CmsMemberPrincipal | null {
    if (!rawToken) return null;
    return this.repository.findSessionPrincipal(this.hash(`session:${rawToken}`), this.now().toISOString());
  }

  logout(rawToken: string | undefined): void {
    if (!rawToken) return;
    this.repository.revokeSession(this.hash(`session:${rawToken}`), this.now().toISOString());
  }

  setAccountStatus(accountId: string, status: CmsAccountStatus): CmsAccount {
    const account = this.repository.setAccountStatus(accountId, status, this.now().toISOString());
    if (!account) throw new AppError(404, 'CMS_ACCOUNT_NOT_FOUND', 'CMS account was not found');
    return account;
  }

  private async issueInvitation(email: string): Promise<void> {
    const now = this.now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS).toISOString();
    const rawToken = this.randomToken();
    const id = this.randomId();
    this.repository.createInvitation({
      id,
      email,
      tokenHash: this.hash(`invite:${rawToken}`),
      expiresAt,
      createdAt,
    });

    const acceptUrl = new URL('/accept-invite', this.options.publicUrl);
    acceptUrl.hash = `token=${encodeURIComponent(rawToken)}`;
    try {
      await this.mail.sendInvitation({ to: email, acceptUrl: acceptUrl.toString(), expiresAt });
      this.repository.markInvitationSent(id, this.now().toISOString());
    } catch {
      this.repository.revokeInvitation(id, this.now().toISOString());
      throw new AppError(502, 'INVITATION_EMAIL_FAILED', 'Could not send the invitation email');
    }
  }

  private hash(value: string): string {
    return crypto.createHmac('sha256', this.options.pepper).update(value).digest('hex');
  }
}

export function canonicalCompanyEmail(input: string): string {
  const email = z.string().trim().email().max(254).parse(input).toLowerCase();
  const separator = email.lastIndexOf('@');
  if (separator < 1 || email.slice(separator + 1) !== COMPANY_DOMAIN) {
    throw new AppError(400, 'EMAIL_DOMAIN_NOT_ALLOWED', `Email must end with @${COMPANY_DOMAIN}`);
  }
  return email;
}

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, 'hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function invalidOtpError(): AppError {
  return new AppError(401, 'INVALID_OR_EXPIRED_CODE', 'The sign-in code is invalid or expired');
}
