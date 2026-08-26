import type { Migration } from './types';

export const cmsAuthMigration: Migration = {
  version: 7,
  name: 'cms_auth',
  up(database) {
    database.exec(`
      CREATE TABLE cms_accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
        accepted_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_cms_accounts_status_email
      ON cms_accounts(status, email COLLATE NOCASE);

      CREATE TABLE cms_account_invitations (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL COLLATE NOCASE,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        sent_at TEXT,
        accepted_at TEXT,
        accepted_account_id TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (accepted_account_id) REFERENCES cms_accounts(id)
      );

      CREATE INDEX idx_cms_invitations_email_created
      ON cms_account_invitations(email COLLATE NOCASE, created_at DESC);
      CREATE INDEX idx_cms_invitations_expires
      ON cms_account_invitations(expires_at);

      CREATE TABLE cms_otp_challenges (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL COLLATE NOCASE,
        account_id TEXT,
        code_hash TEXT NOT NULL,
        ip_hash TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
        expires_at TEXT NOT NULL,
        consumed_at TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (account_id) REFERENCES cms_accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_cms_otp_email_created
      ON cms_otp_challenges(email COLLATE NOCASE, created_at DESC);
      CREATE INDEX idx_cms_otp_ip_created
      ON cms_otp_challenges(ip_hash, created_at DESC);
      CREATE INDEX idx_cms_otp_expires
      ON cms_otp_challenges(expires_at);

      CREATE TABLE cms_auth_sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY (account_id) REFERENCES cms_accounts(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_cms_sessions_account_expires
      ON cms_auth_sessions(account_id, expires_at);
      CREATE INDEX idx_cms_sessions_expires
      ON cms_auth_sessions(expires_at);
    `);
  },
};
