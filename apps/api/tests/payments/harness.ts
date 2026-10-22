import { randomUUID } from 'node:crypto';
import express, { Express, NextFunction, Request, Response } from 'express';
import type { Operator } from '@prisma/client';
import { prisma } from '../../src/infrastructure/database/prisma';
import type {
  BackofficeRoleName,
  CreditDepositInput,
  IResponsibleGamingPolicy,
  IWalletService,
  PlayerAuth,
  TenantContext,
  WalletOpResult,
  WithdrawalLedgerInput,
} from '../../src/domain/contracts';
import { AppError } from '../../src/domain/errors/AppError';
import type { HttpGuards } from '../../src/infrastructure/http/types';
import { PaymentProviderRegistry } from '../../src/infrastructure/payments/PaymentProviderRegistry';
import { PassimpayProvider } from '../../src/infrastructure/payments/PassimpayProvider';
import { WompiProvider } from '../../src/infrastructure/payments/WompiProvider';
import type { FetchLike } from '../../src/infrastructure/payments/types';
import { PrismaAuditLogger } from '../../src/infrastructure/auth/PrismaAuditLogger';
import { CreateDepositUseCase } from '../../src/application/cashier/CreateDepositUseCase';
import { RequestWithdrawalUseCase } from '../../src/application/cashier/RequestWithdrawalUseCase';
import { ReviewWithdrawalUseCase } from '../../src/application/cashier/ReviewWithdrawalUseCase';
import { HandleWebhookUseCase } from '../../src/application/cashier/HandleWebhookUseCase';
import { createCashierRouter } from '../../src/infrastructure/http/routes/cashierRoutes';
import { createWebhookRouter } from '../../src/infrastructure/http/routes/webhookRoutes';
import { createBackofficeWithdrawalRouter } from '../../src/infrastructure/http/routes/backofficeWithdrawalRoutes';

export const PASSIMPAY = { platformId: '4242', apiKey: 'test-passimpay-api-key', baseUrl: 'https://psp.test', webhookIpAllowlist: [] as string[] };
export const WOMPI = {
  publicKey: 'test-wompi-public',
  privateKey: 'test-wompi-private',
  eventsSecret: 'test-wompi-events-secret',
  integritySecret: 'test-wompi-integrity-secret',
  baseUrl: 'https://wompi.test/v1',
};

/** Billetera falsa en memoria: registra llamadas y respeta la idempotencia. */
export class FakeWalletService implements IWalletService {
  calls: Array<{ method: string; input: any }> = [];
  cash = new Map<string, bigint>();
  private results = new Map<string, WalletOpResult>();

  setCash(userId: string, amount: bigint): void {
    this.cash.set(userId, amount);
  }
  callsOf(method: string) {
    return this.calls.filter((c) => c.method === method);
  }
  private op(method: string, input: { userId: string; idempotencyKey: string }, delta: bigint): WalletOpResult {
    this.calls.push({ method, input });
    const prev = this.results.get(input.idempotencyKey);
    if (prev) return { ...prev, idempotentReplay: true };
    const bal = (this.cash.get(input.userId) ?? 0n) + delta;
    if (bal < 0n) throw AppError.insufficientFunds();
    this.cash.set(input.userId, bal);
    const res = { ledgerTransactionId: randomUUID(), balance: bal, idempotentReplay: false };
    this.results.set(input.idempotencyKey, res);
    return res;
  }
  async getBalances(i: { userId: string }) {
    return { currency: 'USD', cash: this.cash.get(i.userId) ?? 0n, bonus: 0n };
  }
  async creditDeposit(i: CreditDepositInput) {
    return this.op('creditDeposit', i, i.amount);
  }
  async reserveWithdrawal(i: WithdrawalLedgerInput) {
    return this.op('reserveWithdrawal', i, -i.amount);
  }
  async releaseWithdrawal(i: WithdrawalLedgerInput) {
    return this.op('releaseWithdrawal', i, i.amount);
  }
  async completeWithdrawal(i: WithdrawalLedgerInput) {
    return this.op('completeWithdrawal', i, 0n);
  }
  async placeBet(): Promise<WalletOpResult> { throw new Error('not used'); }
  async settleWin(): Promise<WalletOpResult> { throw new Error('not used'); }
  async betAndSettle(): Promise<any> { throw new Error('not used'); }
  async rollback(): Promise<WalletOpResult> { throw new Error('not used'); }
  async manualAdjustment(): Promise<WalletOpResult> { throw new Error('not used'); }
  async creditDemo(): Promise<WalletOpResult> { throw new Error('not used'); }
}

/** Política RG de prueba: KYC VERIFIED obligatorio para retirar. */
export const fakePolicy: IResponsibleGamingPolicy = {
  async assertCanDeposit() {},
  async assertCanBet() {},
  async assertCanWithdraw(ctx: PlayerAuth) {
    const u = await prisma.user.findUnique({ where: { id: ctx.userId } });
    if (!u || u.kycStatus !== 'VERIFIED') throw AppError.kycRequired();
  },
};

export function tenantOf(op: Operator): TenantContext {
  return {
    operatorId: op.id,
    slug: op.slug,
    status: 'ACTIVE',
    currencies: op.currencies,
    defaultCurrency: op.defaultCurrency,
    chipsEnabled: op.chipsEnabled,
    chipMinorUnitsPerChip: op.chipMinorUnitsPerChip,
    limits: (op.limits ?? {}) as TenantContext['limits'],
  };
}

/** Guards de prueba: x-test-player=<userId>, x-test-bo=<backofficeUserId>. */
export function testGuards(): HttpGuards {
  const pass = (_req: Request, _res: Response, next: NextFunction) => next();
  return {
    resolveTenant: pass,
    requirePlayer: async (req, _res, next) => {
      try {
        const id = req.header('x-test-player');
        const u = id ? await prisma.user.findUnique({ where: { id }, include: { operator: true } }) : null;
        if (!u) throw AppError.unauthorized();
        req.tenant = tenantOf(u.operator);
        req.player = { kind: 'player', userId: u.id, operatorId: u.operatorId, currency: u.currency, isDemo: u.isDemo };
        next();
      } catch (e) {
        next(e);
      }
    },
    requireBackoffice: (roles: BackofficeRoleName[]) => async (req, _res, next) => {
      try {
        const id = req.header('x-test-bo');
        const u = id ? await prisma.backofficeUser.findUnique({ where: { id } }) : null;
        if (!u) throw AppError.unauthorized();
        if (!roles.includes(u.role as BackofficeRoleName)) throw AppError.forbidden();
        req.backoffice = { kind: 'backoffice', backofficeUserId: u.id, operatorId: u.operatorId, role: u.role as BackofficeRoleName };
        next();
      } catch (e) {
        next(e);
      }
    },
    rateLimit: { login: pass, cashier: pass },
  };
}

export interface Harness {
  app: Express;
  wallet: FakeWalletService;
  registry: PaymentProviderRegistry;
  fetchCalls: Array<{ url: string; init?: any }>;
  review: ReviewWithdrawalUseCase;
  setFetch(handler: (url: string, init?: any) => { status?: number; body: unknown }): void;
}

export function buildHarness(opts: { passimpay?: boolean; wompi?: boolean } = { passimpay: true, wompi: true }): Harness {
  const wallet = new FakeWalletService();
  const fetchCalls: Harness['fetchCalls'] = [];
  let handler: (url: string, init?: any) => { status?: number; body: unknown } = () => ({ body: {} });
  const fetchFn: FetchLike = async (url, init) => {
    fetchCalls.push({ url, init });
    const r = handler(url, init);
    return { ok: (r.status ?? 200) < 400, status: r.status ?? 200, text: async () => JSON.stringify(r.body) };
  };
  const registry = new PaymentProviderRegistry([
    new PassimpayProvider(opts.passimpay ? PASSIMPAY : { baseUrl: PASSIMPAY.baseUrl, webhookIpAllowlist: [] }, fetchFn),
    new WompiProvider(opts.wompi ? WOMPI : { baseUrl: WOMPI.baseUrl }, fetchFn),
  ]);
  const audit = new PrismaAuditLogger(prisma);
  const guards = testGuards();
  const review = new ReviewWithdrawalUseCase({ prisma, registry, wallet, audit });
  const handleWebhook = new HandleWebhookUseCase({ prisma, registry, wallet, withdrawals: review });
  const app = express();
  app.use('/api/webhooks', createWebhookRouter({ handleWebhook }));
  app.use(express.json());
  app.use(
    '/api/cashier',
    createCashierRouter({
      ...guards,
      prisma,
      registry,
      createDeposit: new CreateDepositUseCase({ prisma, registry, responsibleGaming: fakePolicy }),
      requestWithdrawal: new RequestWithdrawalUseCase({ prisma, wallet, responsibleGaming: fakePolicy, audit }),
    }),
  );
  app.use('/api/backoffice/withdrawals', createBackofficeWithdrawalRouter({ ...guards, review }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message, code: err.code });
    return res.status(500).json({ error: String(err) });
  });
  return { app, wallet, registry, fetchCalls, review, setFetch: (h) => (handler = h) };
}
