import { describe, it, expect } from 'vitest';
import { NotificationType } from '@prisma/client';
import {
  emailService,
  createEmailService,
  MockEmailProvider,
  SmtpEmailProvider,
  resolveEmailProvider,
  smtpConfigFromEnv,
  type EmailProvider,
  type SmtpConfig,
} from '../services/email.service';
import { AppError } from '../middleware/error';

// BE-NOTIF-03: Email service abstraction. Mock provider + injected fakes only —
// no SMTP server, no network, no live database.

const validInput = {
  to: 'recipient@example.com',
  subject: 'Donation matched',
  html: '<p>Your donation was matched.</p>',
  text: 'Your donation was matched.',
  type: 'DONATION_MATCHED' as const,
};

const smtpConfig: SmtpConfig = {
  host: 'smtp.example.com',
  port: 587,
  user: 'mailer',
  pass: 's3cret-pass',
  from: 'noreply@fwrp.local',
};

function mockService() {
  const provider = new MockEmailProvider();
  return { provider, service: createEmailService(provider) };
}

describe('BE-NOTIF-03 send + validation', () => {
  it('sends a valid request through the mock provider', async () => {
    const { provider, service } = mockService();
    const result = await service.send({ ...validInput });
    expect(result.messageId).toBe('mock-1');
    expect(result.accepted).toEqual(['recipient@example.com']);
    const [captured] = provider.getCaptured();
    expect(captured.to).toBe('recipient@example.com');
    expect(captured.subject).toBe('Donation matched');
    expect(captured.html).toBe('<p>Your donation was matched.</p>');
    expect(captured.text).toBe('Your donation was matched.');
    expect(captured.type).toBe('DONATION_MATCHED');
  });

  it('accepts html-only and text-only bodies', async () => {
    const { provider, service } = mockService();
    await service.send({ to: 'a@example.com', subject: 'Hi', text: 'plain', type: 'PICKUP_REMINDER' });
    await service.send({ to: 'b@example.com', subject: 'Hi', html: '<p>x</p>', type: 'PICKUP_REMINDER' });
    expect(provider.getCaptured()).toHaveLength(2);
  });

  it('rejects invalid recipients (format, empty, header injection, length)', async () => {
    const { provider, service } = mockService();
    const bad = [
      '',
      '   ',
      'not-an-email',
      'missing-at-sign.com',
      'victim@example.com\r\nBcc: evil@example.com',
      'victim@example.com\nCc: evil@example.com',
      `${'a'.repeat(250)}@example.com`,
      123 as never,
    ];
    for (const to of bad) {
      await expect(service.send({ ...validInput, to: to as never })).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    expect(provider.getCaptured()).toHaveLength(0);
  });

  it('rejects invalid subjects (empty, header injection, length)', async () => {
    const { provider, service } = mockService();
    const bad = ['', '   ', 'Hello\r\nX-Injected: yes', 'Hi\nThere', 'x'.repeat(501)];
    for (const subject of bad) {
      await expect(service.send({ ...validInput, subject })).rejects.toMatchObject({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
      });
    }
    expect(provider.getCaptured()).toHaveLength(0);
  });

  it('requires at least one of html/text', async () => {
    const { provider, service } = mockService();
    const { html: _h, text: _t, ...noBody } = validInput;
    await expect(service.send(noBody as never)).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    await expect(service.send({ ...validInput, html: '', text: '' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    expect(provider.getCaptured()).toHaveLength(0);
  });

  it('rejects an invalid email type but accepts all 12 event types (10 PRD + 2 ORG-03)', async () => {
    const { provider, service } = mockService();
    await expect(service.send({ ...validInput, type: 'BOGUS' as never })).rejects.toMatchObject({
      statusCode: 400,
      code: 'VALIDATION_ERROR',
    });
    for (const type of Object.values(NotificationType)) {
      await service.send({ ...validInput, type });
    }
    expect(provider.getCaptured()).toHaveLength(12);
  });
});

describe('BE-NOTIF-03 mock capture behavior', () => {
  it('captures multiple emails deterministically and independently', async () => {
    const { provider, service } = mockService();
    const r1 = await service.send({ ...validInput, to: 'one@example.com' });
    const r2 = await service.send({ ...validInput, to: 'two@example.com' });
    expect(r1.messageId).toBe('mock-1');
    expect(r2.messageId).toBe('mock-2');
    const captured = provider.getCaptured();
    expect(captured.map((c) => c.to)).toEqual(['one@example.com', 'two@example.com']);
    // Returned copies are independent of internal state.
    captured[0].to = 'mutated@example.com';
    captured.push({ ...captured[0] });
    expect(provider.getCaptured().map((c) => c.to)).toEqual(['one@example.com', 'two@example.com']);
  });

  it('reset clears captures and restarts deterministic ids', async () => {
    const { provider, service } = mockService();
    await service.send({ ...validInput });
    expect(provider.getCaptured()).toHaveLength(1);
    provider.clear();
    expect(provider.getCaptured()).toHaveLength(0);
    const result = await service.send({ ...validInput });
    expect(result.messageId).toBe('mock-1');
  });

  it('mock mode performs no network I/O (pure in-memory capture)', async () => {
    const provider = new MockEmailProvider();
    expect(provider.name).toBe('mock');
    const result = await provider.send({
      to: 'a@example.com',
      subject: 's',
      text: 't',
      type: 'DONATION_CREATED',
    });
    expect(result).toEqual({ messageId: 'mock-1', accepted: ['a@example.com'] });
    expect(provider.getCaptured()[0].sentAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('default singleton uses the mock provider outside production', () => {
    expect(emailService.providerName).toBe('mock');
  });
});

describe('BE-NOTIF-03 provider selection (no real sending)', () => {
  it('selects mock for development/test even when SMTP is configured', () => {
    expect(resolveEmailProvider({ nodeEnv: 'development', smtp: smtpConfig })).toBeInstanceOf(MockEmailProvider);
    expect(resolveEmailProvider({ nodeEnv: 'test', smtp: smtpConfig })).toBeInstanceOf(MockEmailProvider);
    expect(resolveEmailProvider({ nodeEnv: 'development', smtp: null }).name).toBe('mock');
  });

  it('selects SMTP in production when configured, without sending', () => {
    const provider = resolveEmailProvider({ nodeEnv: 'production', smtp: smtpConfig });
    expect(provider).toBeInstanceOf(SmtpEmailProvider);
    expect(provider.name).toBe('smtp');
  });

  it('fails closed in production without SMTP config (never a mock sink)', async () => {
    const provider = resolveEmailProvider({ nodeEnv: 'production', smtp: null });
    expect(provider.name).toBe('unconfigured');
    await expect(
      provider.send({ to: 'a@example.com', subject: 's', text: 't', type: 'DONATION_CREATED' }),
    ).rejects.toMatchObject({ statusCode: 500, code: 'EMAIL_NOT_CONFIGURED' });
  });

  it('returns an explicitly injected provider untouched', () => {
    const custom: EmailProvider = new MockEmailProvider();
    expect(resolveEmailProvider({ nodeEnv: 'production', smtp: smtpConfig, provider: custom })).toBe(custom);
    expect(createEmailService(custom).providerName).toBe('mock');
  });

  it('reads SMTP config from env, defaulting port/from', () => {
    expect(smtpConfigFromEnv({ SMTP_HOST: '', SMTP_PORT: 587, SMTP_USER: '', SMTP_PASS: '', EMAIL_FROM: '' })).toBeNull();
    expect(
      smtpConfigFromEnv({ SMTP_HOST: '  smtp.example.com  ', SMTP_PORT: undefined as never, SMTP_USER: 'u', SMTP_PASS: 'p', EMAIL_FROM: '' }),
    ).toEqual({ host: 'smtp.example.com', port: 587, user: 'u', pass: 'p', from: 'noreply@fwrp.local' });
  });
});

describe('BE-NOTIF-03 SMTP provider mapping (injected transporter, no network)', () => {
  it('maps the message onto the transporter and returns its receipt', async () => {
    const sendMail = async (args: Record<string, unknown>) => ({ messageId: '<abc@smtp>', accepted: [args.to] });
    const provider = new SmtpEmailProvider(smtpConfig, { sendMail } as never);
    const result = await provider.send({
      to: 'r@example.com',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
      type: 'DELIVERY_COMPLETED',
    });
    expect(result).toEqual({ messageId: '<abc@smtp>', accepted: ['r@example.com'] });
  });

  it('masks transporter failures including credentials', async () => {
    const sendMail = async () => {
      throw new Error('535 auth failed for mailer@smtp.example.com pass=s3cret-pass connect smtp.example.com:587');
    };
    const provider = new SmtpEmailProvider(smtpConfig, { sendMail } as never);
    try {
      await provider.send({ to: 'r@example.com', subject: 's', text: 't', type: 'EXPIRY_WARNING' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(500);
      expect((e as AppError).code).toBe('EMAIL_SEND_FAILED');
      const blob = (e as Error).message + JSON.stringify((e as AppError).details ?? '');
      expect(blob).not.toContain('s3cret-pass');
      expect(blob).not.toContain('smtp.example.com');
      expect(blob).not.toContain('535');
    }
  });

  it('rejects construction without a host', () => {
    expect(() => new SmtpEmailProvider({ ...smtpConfig, host: '   ' })).toThrow(AppError);
    try {
      new SmtpEmailProvider({ ...smtpConfig, host: '' });
    } catch (e) {
      expect((e as AppError).code).toBe('EMAIL_NOT_CONFIGURED');
    }
  });
});

describe('BE-NOTIF-03 failure conversion + surface', () => {
  it('converts provider failures to a safe service error without leaking details', async () => {
    const failing: EmailProvider = {
      name: 'failing',
      send: async () => {
        throw new Error('SMTP connect smtp.internal:587 user=mailer token=jwt-secret-value');
      },
    };
    const service = createEmailService(failing);
    try {
      await service.send({ ...validInput });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).statusCode).toBe(500);
      expect((e as AppError).code).toBe('EMAIL_SEND_FAILED');
      const blob = (e as Error).message + JSON.stringify((e as AppError).details ?? '');
      expect(blob).not.toContain('jwt-secret-value');
      expect(blob).not.toContain('smtp.internal');
    }
  });

  it('passes provider AppErrors through unchanged', async () => {
    const off: EmailProvider = {
      name: 'unconfigured',
      send: async () => {
        throw new AppError(500, 'EMAIL_NOT_CONFIGURED', 'Email delivery is not configured');
      },
    };
    await expect(createEmailService(off).send({ ...validInput })).rejects.toMatchObject({
      statusCode: 500,
      code: 'EMAIL_NOT_CONFIGURED',
    });
  });

  it('exposes only the send foundation (no templates/event wiring)', () => {
    expect(typeof emailService.send).toBe('function');
    expect(typeof emailService.providerName).toBe('string');
    const svc = emailService as unknown as Record<string, unknown>;
    for (const banned of ['sendTemplate', 'sendDonationCreated', 'notify', 'dispatch', 'queue', 'outbox']) {
      expect(svc[banned]).toBeUndefined();
    }
  });
});
