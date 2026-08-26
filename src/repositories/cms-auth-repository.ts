import type { AppDatabase } from '../db/database';
import type {
  CmsAccessOverview,
  CmsAccount,
  CmsAccountStatus,
  CmsInvitation,
  CmsMemberPrincipal,
} from '../domain/cms-auth';

interface AccountRow {
  id: string;
  email: string;
  status: CmsAccountStatus;
  accepted_at: string;
  created_at: string;
  updated_at: string;
}

interface InvitationRow {
  id: string;
  email: string;
  token_hash: string;
  expires_at: string;
  sent_at: string | null;
  accepted_at: string | null;
  accepted_account_id: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface OtpChallengeRecord {
  id: string;
  email: string;
  accountId?: string;
  codeHash: string;
  ipHash: string;
  attemptCount: number;
  maxAttempts: number;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

interface OtpChallengeRow {
  id: string;
  email: string;
  account_id: string | null;
  code_hash: string;
  ip_hash: string;
  attempt_count: number;
  max_attempts: number;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

interface SessionPrincipalRow {
  session_id: string;
  account_id: string;
  email: string;
}

export class CmsAuthRepository {
  constructor(private readonly database: AppDatabase) {}

  listAccess(now: string): CmsAccessOverview {
    const accounts = this.database
      .prepare('SELECT * FROM cms_accounts ORDER BY email COLLATE NOCASE')
      .all() as AccountRow[];
    const invitations = this.database
      .prepare('SELECT * FROM cms_account_invitations ORDER BY created_at DESC')
      .all() as InvitationRow[];

    return {
      accounts: accounts.map(mapAccount),
      invitations: invitations.map((row) => mapInvitation(row, now)),
    };
  }

  findAccountById(id: string): CmsAccount | null {
    const row = this.database.prepare('SELECT * FROM cms_accounts WHERE id = ?').get(id) as AccountRow | undefined;
    return row ? mapAccount(row) : null;
  }

  findAccountByEmail(email: string): CmsAccount | null {
    const row = this.database
      .prepare('SELECT * FROM cms_accounts WHERE email = ? COLLATE NOCASE')
      .get(email) as AccountRow | undefined;
    return row ? mapAccount(row) : null;
  }

  createInvitation(input: {
    id: string;
    email: string;
    tokenHash: string;
    expiresAt: string;
    createdAt: string;
  }): void {
    const create = this.database.transaction(() => {
      this.database
        .prepare(`
          UPDATE cms_account_invitations
          SET revoked_at = ?
          WHERE email = ? COLLATE NOCASE
            AND accepted_at IS NULL AND revoked_at IS NULL
        `)
        .run(input.createdAt, input.email);
      this.database
        .prepare(`
          INSERT INTO cms_account_invitations (id, email, token_hash, expires_at, created_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(input.id, input.email, input.tokenHash, input.expiresAt, input.createdAt);
    });
    create.immediate();
  }

  markInvitationSent(id: string, sentAt: string): void {
    this.database.prepare('UPDATE cms_account_invitations SET sent_at = ? WHERE id = ?').run(sentAt, id);
  }

  revokeInvitation(id: string, revokedAt: string): boolean {
    return this.database
      .prepare(`
        UPDATE cms_account_invitations
        SET revoked_at = ?
        WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL
      `)
      .run(revokedAt, id).changes === 1;
  }

  findInvitationById(id: string, now: string): CmsInvitation | null {
    const row = this.database.prepare('SELECT * FROM cms_account_invitations WHERE id = ?').get(id) as
      | InvitationRow
      | undefined;
    return row ? mapInvitation(row, now) : null;
  }

  findInvitationEmail(id: string): string | null {
    const row = this.database.prepare('SELECT email FROM cms_account_invitations WHERE id = ?').get(id) as
      | { email: string }
      | undefined;
    return row?.email ?? null;
  }

  acceptInvitation(tokenHash: string, accountId: string, now: string): CmsAccount | null {
    const accept = this.database.transaction(() => {
      const invitation = this.database
        .prepare(`
          SELECT * FROM cms_account_invitations
          WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
        `)
        .get(tokenHash, now) as InvitationRow | undefined;
      if (!invitation) return null;

      const existing = this.database
        .prepare('SELECT 1 FROM cms_accounts WHERE email = ? COLLATE NOCASE')
        .get(invitation.email);
      if (existing) return null;

      this.database
        .prepare(`
          INSERT INTO cms_accounts (id, email, status, accepted_at, created_at, updated_at)
          VALUES (?, ?, 'active', ?, ?, ?)
        `)
        .run(accountId, invitation.email, now, now, now);
      const update = this.database
        .prepare(`
          UPDATE cms_account_invitations
          SET accepted_at = ?, accepted_account_id = ?
          WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL
        `)
        .run(now, accountId, invitation.id);
      if (update.changes !== 1) throw new Error('Invitation was consumed concurrently');

      return this.findAccountById(accountId);
    });
    return accept.immediate();
  }

  setAccountStatus(id: string, status: CmsAccountStatus, now: string): CmsAccount | null {
    const update = this.database.transaction(() => {
      const result = this.database
        .prepare('UPDATE cms_accounts SET status = ?, updated_at = ? WHERE id = ?')
        .run(status, now, id);
      if (result.changes !== 1) return null;
      if (status === 'disabled') {
        this.database
          .prepare('UPDATE cms_auth_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL')
          .run(now, id);
      }
      return this.findAccountById(id);
    });
    return update.immediate();
  }

  countOtpRequestsForEmail(email: string, since: string): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM cms_otp_challenges WHERE email = ? COLLATE NOCASE AND created_at >= ?')
      .get(email, since) as { count: number };
    return row.count;
  }

  countOtpRequestsForIp(ipHash: string, since: string): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM cms_otp_challenges WHERE ip_hash = ? AND created_at >= ?')
      .get(ipHash, since) as { count: number };
    return row.count;
  }

  latestOtpCreatedAt(email: string): string | null {
    const row = this.database
      .prepare('SELECT created_at FROM cms_otp_challenges WHERE email = ? COLLATE NOCASE ORDER BY created_at DESC LIMIT 1')
      .get(email) as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  createOtpChallenge(input: {
    id: string;
    email: string;
    accountId?: string;
    codeHash: string;
    ipHash: string;
    maxAttempts: number;
    expiresAt: string;
    createdAt: string;
  }): void {
    const create = this.database.transaction(() => {
      this.database
        .prepare(`
          UPDATE cms_otp_challenges
          SET consumed_at = ?
          WHERE email = ? COLLATE NOCASE AND consumed_at IS NULL
        `)
        .run(input.createdAt, input.email);
      this.database
        .prepare(`
          INSERT INTO cms_otp_challenges (
            id, email, account_id, code_hash, ip_hash, max_attempts, expires_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.id,
          input.email,
          input.accountId ?? null,
          input.codeHash,
          input.ipHash,
          input.maxAttempts,
          input.expiresAt,
          input.createdAt,
        );
    });
    create.immediate();
  }

  findOtpChallenge(id: string): OtpChallengeRecord | null {
    const row = this.database.prepare('SELECT * FROM cms_otp_challenges WHERE id = ?').get(id) as
      | OtpChallengeRow
      | undefined;
    return row ? mapOtpChallenge(row) : null;
  }

  consumeOtpChallenge(id: string, now: string): void {
    this.database
      .prepare('UPDATE cms_otp_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
      .run(now, id);
  }

  recordOtpFailure(id: string, now: string): number | null {
    const update = this.database.transaction(() => {
      const result = this.database
        .prepare(`
          UPDATE cms_otp_challenges
          SET attempt_count = attempt_count + 1
          WHERE id = ? AND consumed_at IS NULL AND expires_at > ? AND attempt_count < max_attempts
        `)
        .run(id, now);
      if (result.changes !== 1) return null;
      const row = this.database.prepare('SELECT attempt_count FROM cms_otp_challenges WHERE id = ?').get(id) as {
        attempt_count: number;
      };
      return row.attempt_count;
    });
    return update.immediate();
  }

  consumeOtpAndCreateSession(input: {
    challengeId: string;
    sessionId: string;
    tokenHash: string;
    createdAt: string;
    expiresAt: string;
  }): boolean {
    const consume = this.database.transaction(() => {
      const challenge = this.database
        .prepare(`
          SELECT account_id FROM cms_otp_challenges
          WHERE id = ? AND account_id IS NOT NULL AND consumed_at IS NULL
            AND expires_at > ? AND attempt_count < max_attempts
        `)
        .get(input.challengeId, input.createdAt) as { account_id: string } | undefined;
      if (!challenge) return false;

      const account = this.database
        .prepare("SELECT 1 FROM cms_accounts WHERE id = ? AND status = 'active'")
        .get(challenge.account_id);
      if (!account) return false;

      const updated = this.database
        .prepare('UPDATE cms_otp_challenges SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
        .run(input.createdAt, input.challengeId);
      if (updated.changes !== 1) return false;

      this.database
        .prepare(`
          INSERT INTO cms_auth_sessions (id, account_id, token_hash, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?)
        `)
        .run(input.sessionId, challenge.account_id, input.tokenHash, input.createdAt, input.expiresAt);
      return true;
    });
    return consume.immediate();
  }

  findSessionPrincipal(tokenHash: string, now: string): CmsMemberPrincipal | null {
    const row = this.database
      .prepare(`
        SELECT session.id AS session_id, account.id AS account_id, account.email
        FROM cms_auth_sessions session
        JOIN cms_accounts account ON account.id = session.account_id
        WHERE session.token_hash = ? AND session.revoked_at IS NULL AND session.expires_at > ?
          AND account.status = 'active'
      `)
      .get(tokenHash, now) as SessionPrincipalRow | undefined;
    return row
      ? {
          authMethod: 'member-session',
          role: 'member',
          subject: row.session_id,
          accountId: row.account_id,
          email: row.email,
        }
      : null;
  }

  revokeSession(tokenHash: string, now: string): void {
    this.database
      .prepare('UPDATE cms_auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
      .run(now, tokenHash);
  }
}

function mapAccount(row: AccountRow): CmsAccount {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    acceptedAt: row.accepted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInvitation(row: InvitationRow, now: string): CmsInvitation {
  const status = row.accepted_at
    ? 'accepted'
    : row.revoked_at
      ? 'revoked'
      : row.expires_at <= now
        ? 'expired'
        : 'pending';
  return {
    id: row.id,
    email: row.email,
    status,
    expiresAt: row.expires_at,
    sentAt: row.sent_at ?? undefined,
    acceptedAt: row.accepted_at ?? undefined,
    createdAt: row.created_at,
  };
}

function mapOtpChallenge(row: OtpChallengeRow): OtpChallengeRecord {
  return {
    id: row.id,
    email: row.email,
    accountId: row.account_id ?? undefined,
    codeHash: row.code_hash,
    ipHash: row.ip_hash,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at ?? undefined,
    createdAt: row.created_at,
  };
}
