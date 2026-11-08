import type { CreateIndexesOptions, Db, Document, IndexSpecification } from 'mongodb';

/** What a module declares about each collection it owns: validator + indexes, applied by `npm run migrate`. */
export type CollectionSpec = {
  name: string;
  validator?: Document;
  indexes: { key: IndexSpecification; options?: CreateIndexesOptions & { name: string } }[];
};

/**
 * Idempotent: creates missing collections, updates validators, creates missing indexes. A validator is rewritten only
 * when its rule changed: `collMod` needs the dbAdmin role, which a deploy that changes no rule must not require (the
 * database users of staging and production may have readWrite only).
 */
export async function applyCollectionSpecs(db: Db, specs: CollectionSpec[]) {
  const existing = new Map((await db.listCollections().toArray()).map((c) => [c.name, ('options' in c ? c.options : undefined) ?? {}]));
  for (const spec of specs) {
    const validation = spec.validator ? { validator: spec.validator, validationLevel: 'strict', validationAction: 'error' } : {};
    const current = existing.get(spec.name);
    if (!current) await db.createCollection(spec.name, validation);
    else if (spec.validator && !sameValidation(current, validation)) await db.command({ collMod: spec.name, ...validation });
    for (const ix of spec.indexes) await db.collection(spec.name).createIndex(ix.key, ix.options);
  }
}

/** The collection's stored rule against the declared one, whatever the key order. */
function sameValidation(current: Document, wanted: Document) {
  return (
    canonical(current.validator) === canonical(wanted.validator) &&
    (current.validationLevel ?? 'strict') === wanted.validationLevel &&
    (current.validationAction ?? 'error') === wanted.validationAction
  );
}

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
};

/** `$jsonSchema` helpers: keep validators short and readable. */
export const bson = {
  objectId: { bsonType: 'objectId' },
  date: { bsonType: 'date' },
  string: (extra: Document = {}) => ({ bsonType: 'string', ...extra }),
  int: (extra: Document = {}) => ({ bsonType: ['int', 'long'], ...extra }),
  bool: { bsonType: 'bool' },
  enumOf: (values: readonly string[]) => ({ enum: [...values] }),
  array: (items: Document, extra: Document = {}) => ({ bsonType: 'array', items, ...extra }),
  // MongoDB refuses `required: []`: left out when nothing is required.
  object: (properties: Document, required: string[] = [], extra: Document = {}) => ({ bsonType: 'object', properties, ...(required.length ? { required } : {}), ...extra }),
  nullable: (schema: Document) => ({ anyOf: [schema, { bsonType: 'null' }] }),
  /** GeoJSON Point: coordinates are [longitude, latitude], in that order. */
  geoPoint: {
    bsonType: 'object',
    required: ['type', 'coordinates'],
    properties: {
      type: { enum: ['Point'] },
      coordinates: {
        bsonType: 'array', minItems: 2, maxItems: 2,
        items: [{ bsonType: ['double', 'int'], minimum: -180, maximum: 180 }, { bsonType: ['double', 'int'], minimum: -90, maximum: 90 }],
      },
    },
  },
  imageRef: { bsonType: 'object', required: ['mediaId', 'url'], properties: { mediaId: { bsonType: 'objectId' }, url: { bsonType: 'string' } } },
};
