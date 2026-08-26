import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDatabase, type AppDatabase } from '../src/db/database';
import { migrateDatabase } from '../src/db/migrate';
import { CmsAuthRepository } from '../src/repositories/cms-auth-repository';
import { CmsAuthService } from '../src/services/cms-auth-service';
import type { CmsMailGateway } from '../src/services/cms-mail-service';

const databases: AppDatabase[] = [];

function setup() {
  const database = createDatabase(':memory:');
  databases.push(database);
  migrateDatabase(database);
  const repository = new CmsAuthRepository(database);
  const sendInvitation = vi.fn<CmsMailGateway['sendInvitation']>();
  const sendOtp = vi.fn<CmsMailGateway['sendOtp']>();
  const mail: CmsMailGateway = { sendInvitation, sendOtp };
  let now = new Date('2026-08-26T00:00:00.000Z');
  const ids = [
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000004',
  ];
  const tokens = ['invite-token-that-is-long-enough-000001', 'session-token-that-is-long-enough-00001'];
  const service = new CmsAuthService(repository, mail, {
    pepper: 'test-pepper-that-is-at-least-32-characters',
    publicUrl: 'https://cms.example.com',
    now: () => now,
    randomId: () => ids.shift()!,
    randomToken: () => tokens.shift()!,
    otpGenerator: () => '012345',
  });
  return { database, repository, service, sendInvitation, sendOtp, setNow: (value: string) => { now = new Date(value); } };
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('CmsAuthService', () => {
  it('creates an account only after acceptance and issues a fixed 72-hour OTP session', async () => {
    const { database, repository, service, sendInvitation, sendOtp, setNow } = setup();

    await service.invite(' Person@MatechMobile.com ');
    expect(repository.findAccountByEmail('person@matechmobile.com')).toBeNull();
    expect(sendInvitation).toHaveBeenCalledWith(expect.objectContaining({
      to: 'person@matechmobile.com',
      acceptUrl: expect.stringContaining('/accept-invite#token=invite-token'),
    }));
    const invitationRow = database.prepare('SELECT token_hash FROM cms_account_invitations').get() as { token_hash: string };
    expect(invitationRow.token_hash).not.toContain('invite-token');

    const account = service.acceptInvitation('invite-token-that-is-long-enough-000001');
    expect(account.email).toBe('person@matechmobile.com');
    expect(() => service.acceptInvitation('invite-token-that-is-long-enough-000001')).toThrow(/invalid|expired|already used/i);

    const request = await service.requestOtp('person@matechmobile.com', '127.0.0.1');
    expect(sendOtp).toHaveBeenCalledWith(expect.objectContaining({ to: account.email, code: '012345' }));
    const challengeRow = database.prepare('SELECT code_hash FROM cms_otp_challenges').get() as { code_hash: string };
    expect(challengeRow.code_hash).not.toContain('012345');

    const session = service.verifyOtp(request.challengeId, '012345');
    expect(session.expiresAt).toBe('2026-08-29T00:00:00.000Z');
    expect(service.authenticateSession(session.rawToken)?.email).toBe(account.email);
    expect(() => service.verifyOtp(request.challengeId, '012345')).toThrow(/invalid or expired/i);

    setNow('2026-08-29T00:00:00.000Z');
    expect(service.authenticateSession(session.rawToken)).toBeNull();
  });

  it('does not reveal or email unknown accounts and enforces the company domain', async () => {
    const { service, sendOtp } = setup();
    const result = await service.requestOtp('unknown@matechmobile.com', '127.0.0.1');
    expect(result.message).toMatch(/if this address has active/i);
    expect(sendOtp).not.toHaveBeenCalled();
    expect(() => service.verifyOtp(result.challengeId, '012345')).toThrow(/invalid or expired/i);
    await expect(service.requestOtp('person@gmail.com', '127.0.0.1')).rejects.toMatchObject({ code: 'EMAIL_DOMAIN_NOT_ALLOWED' });
  });

  it('keeps the OTP request response generic when email delivery fails', async () => {
    const { service, sendOtp } = setup();
    await service.invite('person@matechmobile.com');
    service.acceptInvitation('invite-token-that-is-long-enough-000001');
    sendOtp.mockRejectedValueOnce(new Error('SMTP unavailable'));

    await expect(service.requestOtp('person@matechmobile.com', '127.0.0.1')).resolves.toMatchObject({
      message: expect.stringMatching(/if this address has active/i),
    });
  });

  it('locks a challenge after five failed attempts', async () => {
    const { service } = setup();
    await service.invite('person@matechmobile.com');
    service.acceptInvitation('invite-token-that-is-long-enough-000001');
    const result = await service.requestOtp('person@matechmobile.com', '127.0.0.1');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(() => service.verifyOtp(result.challengeId, '999999')).toThrow(/invalid or expired/i);
    }
    expect(() => service.verifyOtp(result.challengeId, '012345')).toThrow(/invalid or expired/i);
  });
});
