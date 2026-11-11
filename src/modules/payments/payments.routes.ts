import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { Type } from 'typebox';

import type { Config } from '../../config/env.js';
import { actorOf, requireAuth } from '../../platform/auth/auth.js';
import type { Clock } from '../../platform/clock.js';
import { errors } from '../../platform/http/errors.js';
import { toObjectId } from '../../platform/http/schemas.js';
import { randomCode } from '../../platform/security/crypto.js';
import { paymentView, payoutView, type PaymentsService } from './payments.service.js';
import { PAYMENT_METHODS, PAYOUT_STATUSES } from './payments.types.js';
import { SIMULATOR_SIGNATURE_HEADER, signSimulatorBody, type SimulatedEventType } from './providers.js';

export const PaymentView = Type.Object({
  reference: Type.String(),
  status: Type.String(),
  fulfillment: Type.String(),
  amount: Type.Number(),
  currency: Type.String(),
  method: Type.String(),
  purpose: Type.String(),
  purposeRef: Type.String(),
  checkoutUrl: Type.Union([Type.String(), Type.Null()]),
  expiresAt: Type.String(),
});
export const PayoutView = Type.Object({
  id: Type.String(), kind: Type.String(), reason: Type.String(), amount: Type.Number(), method: Type.String(),
  status: Type.String(), phoneMasked: Type.String(), createdAt: Type.String(),
});
const ReferenceParams = Type.Object({ reference: Type.String({ pattern: '^PAY_[0-9A-Z]{20}$' }) }, { additionalProperties: false });
const SIM_ACTIONS = ['pay', 'fail', 'cancel', 'duplicate'] as const;

type Deps = { service: PaymentsService; config: Config; clock: Clock; requireFinance: preHandlerHookHandler; requireAdmin: preHandlerHookHandler };

const MethodStatusView = Type.Object({ method: Type.String(), available: Type.Boolean(), offSince: Type.Union([Type.String(), Type.Null()]), note: Type.Union([Type.String(), Type.Null()]) });
const MethodsView = Type.Object({ items: Type.Array(MethodStatusView) });

export function registerPaymentsRoutes(root: FastifyInstance, { service, config, clock, requireFinance, requireAdmin }: Deps) {
  const app = root.withTypeProvider<TypeBoxTypeProvider>();

  // Which of Wave / Orange Money take payments right now: a switched-off one is greyed, with a banner on the home.
  app.get('/payments/methods', { preHandler: requireAuth, schema: { tags: ['payments'], response: { 200: MethodsView } } }, async () => ({ items: await service.methods() }));

  // The admins' switch, app-wide (an outage at the provider). Businesses, organizers and students waiting on a
  // payment with it are told.
  app.put(
    '/admin/payments/methods/:method',
    {
      preHandler: [requireAuth, requireAdmin],
      schema: {
        tags: ['admin'],
        params: Type.Object({ method: Type.Enum(PAYMENT_METHODS) }, { additionalProperties: false }),
        body: Type.Object({ enabled: Type.Boolean(), note: Type.Optional(Type.Union([Type.String({ maxLength: 200 }), Type.Null()])) }, { additionalProperties: false }),
        response: { 200: MethodsView },
      },
    },
    async (req) => ({ items: await service.setMethod(req.params.method, req.body.enabled, toObjectId(actorOf(req).userId), req.body.note ?? null) }),
  );

  // The app polls this after the checkout page: only the server decides that money arrived.
  app.get(
    '/payments/:reference',
    { preHandler: requireAuth, schema: { tags: ['payments'], params: ReferenceParams, response: { 200: PaymentView } } },
    async (req) => paymentView(await service.getForUser(req.params.reference, toObjectId(actorOf(req).userId))),
  );

  // Refunds and claims sent to my Wave / Orange Money number.
  app.get(
    '/me/payouts',
    { preHandler: requireAuth, schema: { tags: ['payments'], response: { 200: Type.Object({ items: Type.Array(PayoutView) }) } } },
    async (req) => ({ items: (await service.listPayouts({ userId: toObjectId(actorOf(req).userId) })).map(payoutView) }),
  );

  app.get(
    '/admin/payouts',
    {
      preHandler: [requireAuth, requireFinance],
      schema: { tags: ['admin'], querystring: Type.Object({ status: Type.Optional(Type.Enum(PAYOUT_STATUSES)) }, { additionalProperties: false }), response: { 200: Type.Object({ items: Type.Array(PayoutView) }) } },
    },
    async (req) => ({ items: (await service.listPayouts({ status: req.query.status }, 200)).map(payoutView) }),
  );

  if (!config.PAYMENTS_SIMULATOR) return;

  // Webhooks need the exact bytes the provider signed: this scope keeps JSON bodies raw.
  void root.register(async (scope) => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
    scope.post('/payments/webhooks/simulated', { schema: { hide: true } }, async (req, reply) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
      const { status, outcome } = await service.receiveWebhook('simulated', raw, req.headers);
      req.log.info({ outcome }, 'payment webhook');
      return reply.status(status).send({ received: status === 200 });
    });
  });

  // ---- Development checkout page: stands in for the Wave / Orange Money screens --------------------------------

  app.get('/dev/payment-simulator/:reference', { schema: { tags: ['dev'], params: ReferenceParams } }, async (req, reply) => {
    const p = await service.findByReference(req.params.reference);
    if (!p) throw errors.notFound('Paiement introuvable.');
    return reply.type('text/html; charset=utf-8').send(simulatorPage(p.reference, p.amount, p.method, p.description, p.status));
  });

  app.post(
    '/dev/payment-simulator/:reference/:action',
    { schema: { tags: ['dev'], params: Type.Object({ reference: ReferenceParams.properties.reference, action: Type.Enum(SIM_ACTIONS) }) } },
    async (req, reply) => {
      const p = await service.findByReference(req.params.reference);
      if (!p) throw errors.notFound('Paiement introuvable.');
      const { action } = req.params;
      const type: SimulatedEventType = action === 'fail' ? 'checkout.failed' : action === 'cancel' ? 'checkout.cancelled' : 'checkout.completed';
      const body = JSON.stringify({
        id: `evt_${randomCode(16)}`,
        type,
        data: { reference: p.reference, amount: p.amount, currency: p.currency, transactionId: type === 'checkout.completed' ? `simtx_${randomCode(12)}` : null },
      });
      // Through the real webhook route: signature check, inbox, dedupe, processing.
      const send = () =>
        req.server.inject({
          method: 'POST',
          url: '/api/v1/payments/webhooks/simulated',
          headers: { 'content-type': 'application/json', [SIMULATOR_SIGNATURE_HEADER]: signSimulatorBody(config.SIMULATOR_WEBHOOK_SECRET, body, clock.now()) },
          payload: body,
        });
      await send();
      if (action === 'duplicate') await send();

      const status = action === 'fail' ? 'failed' : action === 'cancel' ? 'cancelled' : 'succeeded';
      if (p.returnUrl) {
        const back = new URL(p.returnUrl);
        back.searchParams.set('ref', p.reference);
        back.searchParams.set('status', status);
        return reply.redirect(back.toString(), 303);
      }
      return reply.type('text/html; charset=utf-8').send(donePage(status));
    },
  );
}

const fcfa = (n: number) => `${String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} FCFA`;
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function shell(title: string, body: string) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>
body{font-family:-apple-system,system-ui,sans-serif;background:#F4F6FA;margin:0;padding:24px;color:#14213D}
.card{background:#fff;border-radius:16px;padding:20px;max-width:420px;margin:0 auto;box-shadow:0 2px 8px rgba(0,0,0,.06)}
.tag{display:inline-block;background:#FFF4E5;color:#9A5B00;font-size:12px;font-weight:700;padding:4px 8px;border-radius:999px}
h1{font-size:28px;margin:12px 0 4px}p{color:#5B6475;margin:4px 0 16px}
button{display:block;width:100%;padding:14px;margin-top:10px;border:0;border-radius:12px;font-size:16px;font-weight:600}
.pay{background:#1DC8F2;color:#fff}.alt{background:#EEF1F6;color:#14213D}
</style></head><body><div class="card">${body}</div></body></html>`;
}

function simulatorPage(reference: string, amount: number, method: string, description: string, status: string) {
  const provider = method === 'wave' ? 'Wave' : 'Orange Money';
  if (status !== 'created' && status !== 'pending') return donePage(status);
  const action = (a: string, label: string, cls: string) =>
    `<form method="post" action="/api/v1/dev/payment-simulator/${reference}/${a}" enctype="text/plain"><button class="${cls}">${label}</button></form>`;
  return shell(
    `${provider} (simulation)`,
    `<span class="tag">SIMULATION · ${provider}</span><h1>${fcfa(amount)}</h1><p>${escapeHtml(description)}</p>
${action('pay', 'Payer', 'pay')}${action('fail', 'Échec du paiement', 'alt')}${action('cancel', 'Annuler', 'alt')}${action('duplicate', 'Payer (webhook envoyé 2 fois)', 'alt')}
<p style="margin-top:16px;font-size:12px">Référence ${reference}</p>`,
  );
}

function donePage(status: string) {
  const text: Record<string, string> = { succeeded: 'Paiement effectué.', failed: 'Le paiement a échoué.', cancelled: 'Paiement annulé.', expired: 'Ce paiement a expiré.' };
  return shell('Paiement', `<h1>${text[status] ?? 'Paiement traité.'}</h1><p>Retourne dans l’application UGB Connect.</p>`);
}
