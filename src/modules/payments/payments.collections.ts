import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import {
  PAYMENT_METHODS,
  PAYMENT_PURPOSES,
  PAYMENT_STATUSES,
  PAYOUT_KINDS,
  PAYOUT_REASONS,
  PAYOUT_STATUSES,
  PROVIDERS,
} from './payments.types.js';

const amount = bson.int({ minimum: 1, maximum: 5_000_000 });

export const paymentsCollections: CollectionSpec[] = [
  {
    name: 'payments',
    validator: {
      $jsonSchema: bson.object(
        {
          reference: bson.string({ pattern: '^PAY_[0-9A-Z]{20}$' }),
          userId: bson.objectId,
          purpose: bson.enumOf(PAYMENT_PURPOSES),
          purposeRef: bson.objectId,
          amount,
          currency: bson.enumOf(['XOF']),
          method: bson.enumOf(PAYMENT_METHODS),
          provider: bson.enumOf(PROVIDERS),
          status: bson.enumOf(PAYMENT_STATUSES),
          fulfillment: bson.enumOf(['pending', 'fulfilled', 'unfulfillable']),
          expiresAt: bson.date,
        },
        ['reference', 'userId', 'purpose', 'purposeRef', 'amount', 'currency', 'method', 'provider', 'status', 'fulfillment', 'expiresAt', 'statusHistory', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { reference: 1 }, options: { name: 'reference_unique', unique: true } },
      { key: { provider: 1, providerTxnId: 1 }, options: { name: 'provider_txn_unique', unique: true, partialFilterExpression: { providerTxnId: { $type: 'string' } } } },
      { key: { status: 1, expiresAt: 1 }, options: { name: 'status_expires' } },
      { key: { purpose: 1, purposeRef: 1 }, options: { name: 'purpose_ref' } },
      { key: { userId: 1, createdAt: -1 }, options: { name: 'user_recent' } },
    ],
  },
  {
    name: 'paymentEvents',
    validator: {
      $jsonSchema: bson.object(
        { provider: bson.enumOf(PROVIDERS), providerEventId: bson.string({ minLength: 1, maxLength: 200 }), signatureValid: bson.bool, receivedAt: bson.date },
        ['provider', 'providerEventId', 'type', 'payload', 'signatureValid', 'receivedAt'],
      ),
    },
    indexes: [
      // A provider re-sending an event hits this index: answered 200, processed once.
      { key: { provider: 1, providerEventId: 1 }, options: { name: 'provider_event_unique', unique: true } },
      { key: { processedAt: 1, receivedAt: 1 }, options: { name: 'unprocessed' } },
    ],
  },
  {
    name: 'payouts',
    validator: {
      $jsonSchema: bson.object(
        {
          kind: bson.enumOf(PAYOUT_KINDS),
          beneficiaryUserId: bson.objectId,
          phone: bson.string({ pattern: '^\\+221[0-9]{9}$' }),
          method: bson.enumOf(PAYMENT_METHODS),
          provider: bson.enumOf(PROVIDERS),
          amount,
          reason: bson.enumOf(PAYOUT_REASONS),
          status: bson.enumOf(PAYOUT_STATUSES),
          idempotencyKey: bson.string({ minLength: 3, maxLength: 120 }),
          attempts: bson.int({ minimum: 0 }),
        },
        ['kind', 'beneficiaryUserId', 'phone', 'method', 'provider', 'amount', 'reason', 'source', 'status', 'idempotencyKey', 'attempts', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { idempotencyKey: 1 }, options: { name: 'idempotency_unique', unique: true } },
      { key: { status: 1, createdAt: 1 }, options: { name: 'status_created' } },
      { key: { beneficiaryUserId: 1, createdAt: -1 }, options: { name: 'beneficiary_recent' } },
    ],
  },
  // The admins' Wave / Orange Money switches: a single document.
  { name: 'paymentSettings', indexes: [] },
];
