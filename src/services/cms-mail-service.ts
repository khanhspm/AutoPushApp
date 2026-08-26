import nodemailer from 'nodemailer';

export interface CmsMailGateway {
  sendInvitation(input: { to: string; acceptUrl: string; expiresAt: string }): Promise<void>;
  sendOtp(input: { to: string; code: string; expiresAt: string }): Promise<void>;
}

export interface GmailSmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  appPassword?: string;
  from?: string;
}

export class GmailSmtpMailGateway implements CmsMailGateway {
  private readonly transporter?: nodemailer.Transporter;

  constructor(private readonly options: GmailSmtpOptions) {
    if (options.user && options.appPassword && options.from) {
      this.transporter = nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        auth: { user: options.user, pass: options.appPassword },
      });
    }
  }

  async sendInvitation(input: { to: string; acceptUrl: string; expiresAt: string }): Promise<void> {
    const transporter = this.requireTransporter();
    const safeUrl = escapeHtml(input.acceptUrl);
    const safeExpiry = escapeHtml(input.expiresAt);
    await transporter.sendMail({
      from: this.options.from,
      to: input.to,
      subject: 'You are invited to AutoPush CMS',
      text: [
        `An administrator invited ${input.to} to AutoPush CMS.`,
        '',
        `Accept the invitation: ${input.acceptUrl}`,
        `This invitation expires at ${input.expiresAt}.`,
        '',
        'Your account will not be created if you ignore this email.',
      ].join('\n'),
      html: `
        <p>An administrator invited <strong>${escapeHtml(input.to)}</strong> to AutoPush CMS.</p>
        <p><a href="${safeUrl}">Accept invitation</a></p>
        <p>This invitation expires at ${safeExpiry}.</p>
        <p>Your account will not be created if you ignore this email.</p>
      `,
    });
  }

  async sendOtp(input: { to: string; code: string; expiresAt: string }): Promise<void> {
    const transporter = this.requireTransporter();
    await transporter.sendMail({
      from: this.options.from,
      to: input.to,
      subject: 'Your AutoPush CMS sign-in code',
      text: [
        `Your AutoPush CMS sign-in code is ${input.code}.`,
        `It expires at ${input.expiresAt} and can be used once.`,
        '',
        'Ignore this email if you did not request the code.',
      ].join('\n'),
      html: `
        <p>Your AutoPush CMS sign-in code is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 0.2em">${escapeHtml(input.code)}</p>
        <p>It expires at ${escapeHtml(input.expiresAt)} and can be used once.</p>
        <p>Ignore this email if you did not request the code.</p>
      `,
    });
  }

  private requireTransporter(): nodemailer.Transporter {
    if (!this.transporter) {
      throw new Error('Gmail SMTP is not configured');
    }
    return this.transporter;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;',
    };
    return entities[character];
  });
}
