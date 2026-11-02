import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { z } from 'zod';
import { NotificationType } from '@prisma/client';
import { AppError } from '../middleware/error';
import { formatZodError } from '../middleware/validate';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// BE-NOTIF-03: email service abstraction (D-11).
// Stable send() interface + deterministic mock provider for development/test
// + SMTP provider for production (selected via existing SMTP_* env vars).
// No business-event wiring (Phase 13), no templates per event, no SMS/push,
// no outbox/queue, no EmailLog model. Not coupled to notificationService.

// Email type: the 10 PRD S17 notification events, so future Phase 13 wiring
// can pass a notification's type straight through. No event handlers here.
// SEC-02 adds PASSWORD_RESET: transactional mail with no in-app notification.
export const EMAIL_ONLY_TYPES = ['PASSWORD_RESET'] as const;
export type EmailType = NotificationType | (typeof EMAIL_ONLY_TYPES)[number];

const NO_CRLF = /[\r\n]/;
const MAX_ADDRESS_LENGTH = 254;
const MAX_SUBJECT_LENGTH = 500;
const MAX_HTML_LENGTH = 500000;
const MAX_TEXT_LENGTH = 200000;

const sendEmailSchema = z
  .object({
    // Single recipient. CR/LF rejected to block header-injection payloads.
    to: z
      .string()
      .trim()
      .min(1, 'Recipient address is required')
      .max(MAX_ADDRESS_LENGTH)
      .email('Recipient address must be a valid email')
      .refine((v) => !NO_CRLF.test(v), 'Recipient address must not contain line breaks'),
    subject: z
      .string()
      .trim()
      .min(1, 'Subject is required')
      .max(MAX_SUBJECT_LENGTH)
      .refine((v) => !NO_CRLF.test(v), 'Subject must not contain line breaks'),
    html: z.string().min(1).max(MAX_HTML_LENGTH).optional(),
    text: z.string().min(1).max(MAX_TEXT_LENGTH).optional(),
    type: z.union([z.nativeEnum(NotificationType), z.enum(EMAIL_ONLY_TYPES)]),
  })
  .refine((v) => v.html !== undefined || v.text !== undefined, {
    message: 'Either html or text body is required',
    path: ['html'],
  });

export type SendEmailInput = z.input<typeof sendEmailSchema>;

export interface ValidatedEmailMessage {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  type: EmailType;
}

export interface EmailSendResult {
  messageId: string;
  accepted: string[];
}

export interface CapturedEmail extends ValidatedEmailMessage {
  provider: 'mock';
  sentAt: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: ValidatedEmailMessage): Promise<EmailSendResult>;
}

// Deterministic local provider: captures instead of sending. No credentials,
// no network. Counter resets with clear() so messageIds stay deterministic.
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock' as const;
  private captured: CapturedEmail[] = [];
  private counter = 0;

  async send(message: ValidatedEmailMessage): Promise<EmailSendResult> {
    this.counter += 1;
    this.captured.push({
      ...message,
      provider: 'mock',
      sentAt: new Date().toISOString(),
    });
    return { messageId: `mock-${this.counter}`, accepted: [message.to] };
  }

  getCaptured(): CapturedEmail[] {
    return this.captured.map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.captured = [];
    this.counter = 0;
  }
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure?: boolean;
}

// Production provider. The transporter is injectable so tests can verify the
// mapping without any network. SMTP internals are never propagated to callers.
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp' as const;
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: SmtpConfig, transporter?: Transporter) {
    if (!config || typeof config.host !== 'string' || config.host.trim() === '') {
      throw new AppError(500, 'EMAIL_NOT_CONFIGURED', 'SMTP email provider is not configured');
    }
    this.from = config.from;
    this.transporter =
      transporter ??
      nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure ?? config.port === 465,
        auth: { user: config.user, pass: config.pass },
      });
  }

  async send(message: ValidatedEmailMessage): Promise<EmailSendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      const accepted = Array.isArray(info.accepted)
        ? info.accepted.map((entry: unknown) => String(entry))
        : [message.to];
      return { messageId: String(info.messageId ?? ''), accepted };
    } catch {
      throw new AppError(500, 'EMAIL_SEND_FAILED', 'Failed to send email');
    }
  }
}

// Fail-closed provider: production without SMTP config must error loudly
// instead of silently dropping mail into the mock sink.
class UnconfiguredEmailProvider implements EmailProvider {
  readonly name = 'unconfigured' as const;

  async send(): Promise<EmailSendResult> {
    throw new AppError(500, 'EMAIL_NOT_CONFIGURED', 'Email delivery is not configured');
  }
}

type EnvSmtp = Pick<
  typeof env,
  'SMTP_HOST' | 'SMTP_PORT' | 'SMTP_USER' | 'SMTP_PASS' | 'EMAIL_FROM'
>;

export function smtpConfigFromEnv(e: EnvSmtp = env): SmtpConfig | null {
  const host = (e.SMTP_HOST ?? '').trim();
  if (!host) return null;
  return {
    host,
    port: e.SMTP_PORT ?? 587,
    user: e.SMTP_USER ?? '',
    pass: e.SMTP_PASS ?? '',
    from: (e.EMAIL_FROM ?? '').trim() || 'noreply@fwrp.local',
  };
}

export interface EmailProviderSelection {
  nodeEnv?: string;
  smtp?: SmtpConfig | null;
  provider?: EmailProvider;
}

// D-11: non-production always uses the mock (dev never sends real mail,
// even if SMTP vars happen to be set). Production uses SMTP when configured
// and fails closed otherwise — the mock is never a production sink.
export function resolveEmailProvider(selection: EmailProviderSelection = {}): EmailProvider {
  if (selection.provider) return selection.provider;
  const nodeEnv = selection.nodeEnv ?? env.NODE_ENV;
  if (nodeEnv === 'production') {
    const smtp = selection.smtp !== undefined ? selection.smtp : smtpConfigFromEnv();
    if (smtp) return new SmtpEmailProvider(smtp);
    return new UnconfiguredEmailProvider();
  }
  return new MockEmailProvider();
}

export interface EmailService {
  readonly providerName: string;
  send(input: SendEmailInput): Promise<EmailSendResult>;
}

export function createEmailService(provider?: EmailProvider): EmailService {
  const resolved = provider ?? resolveEmailProvider();
  return {
    get providerName() {
      return resolved.name;
    },
    async send(input: SendEmailInput): Promise<EmailSendResult> {
      const parsed = sendEmailSchema.safeParse(input);
      if (!parsed.success) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Validation failed', formatZodError(parsed.error));
      }
      const message: ValidatedEmailMessage = { ...parsed.data };
      let result: EmailSendResult;
      try {
        result = await resolved.send(message);
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(500, 'EMAIL_SEND_FAILED', 'Failed to send email');
      }
      // Metadata only: never recipient PII, subject, or bodies.
      logger.info(
        { provider: resolved.name, type: message.type, messageId: result.messageId },
        'Email dispatched',
      );
      return result;
    },
  };
}

// Shared singleton (mock in development/test per D-11). Phase 13 wires events here.
export const emailService: EmailService = createEmailService();
