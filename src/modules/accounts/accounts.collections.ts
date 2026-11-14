import type { DataMigration } from '../../platform/db/migrations.js';
import { bson, type CollectionSpec } from '../../platform/db/schema.js';
import { CAMPUSES, PLATFORM_ROLES, REGIONS, STORED_STUDENT_NUMBER_RE, UFR_CODES } from './accounts.types.js';

export const accountsCollections: CollectionSpec[] = [
  {
    name: 'users',
    validator: {
      $jsonSchema: bson.object(
        {
          phone: bson.string({ pattern: '^\\+221(70|71|75|76|77|78)\\d{7}$' }),
          passwordHash: { bsonType: ['string', 'null'] },
          firstName: bson.string({ minLength: 1, maxLength: 60 }),
          lastName: bson.string({ minLength: 1, maxLength: 60 }),
          status: bson.enumOf(['active', 'suspended', 'deleted']),
          platformRoles: bson.array(bson.enumOf(PLATFORM_ROLES)),
          restoIds: bson.array(bson.objectId),
          login: bson.object({ failedCount: bson.int({ minimum: 0 }) }, ['failedCount']),
          payoutAccount: bson.object({ phone: bson.string(), verifiedAt: bson.date }, ['phone', 'verifiedAt']),
          email: bson.nullable(bson.object({ address: bson.string({ maxLength: 254 }), verifiedAt: bson.nullable(bson.date), addedAt: bson.date }, ['address', 'addedAt'])),
          avatar: bson.nullable(bson.imageRef),
          lastLocation: bson.nullable(bson.object({ point: bson.geoPoint, accuracyM: bson.nullable({ bsonType: ['double', 'int'], minimum: 0 }), updatedAt: bson.date }, ['point', 'updatedAt'])),
          createdAt: bson.date,
          updatedAt: bson.date,
        },
        ['phone', 'firstName', 'lastName', 'status', 'platformRoles', 'login', 'notificationPrefs', 'payoutAccount', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { phone: 1 }, options: { name: 'phone_unique', unique: true } },
      { key: { platformRoles: 1 }, options: { name: 'platform_roles', sparse: true } },
      // One account per e-mail address; accounts without one are not indexed.
      { key: { 'email.address': 1 }, options: { name: 'email_unique', unique: true, partialFilterExpression: { 'email.address': { $type: 'string' } } } },
      // Ready for the future "near me" features; documents without a position are skipped.
      { key: { 'lastLocation.point': '2dsphere' }, options: { name: 'last_location_geo' } },
    ],
  },
  {
    name: 'studentProfiles',
    validator: {
      $jsonSchema: bson.object(
        {
          userId: bson.objectId,
          // Looser than the API (STUDENT_NUMBER_RE, P + 4 digits or more): numbers saved under the previous rule stay valid.
          studentNumber: bson.nullable(bson.string({ pattern: STORED_STUDENT_NUMBER_RE.source })),
          campus: bson.enumOf(CAMPUSES),
          onCampus: bson.bool,
          village: { bsonType: ['string', 'null'] },
          room: { bsonType: ['string', 'null'] },
          ufr: bson.nullable(bson.enumOf(UFR_CODES)),
          region: bson.nullable(bson.enumOf(REGIONS)),
          academicGroupIds: bson.array(bson.objectId, { maxItems: 5 }),
          verification: bson.object({ status: bson.enumOf(['unverified', 'verified']) }, ['status']),
        },
        ['userId', 'studentNumber', 'campus', 'onCampus', 'academicGroupIds', 'verification', 'createdAt', 'updatedAt'],
      ),
    },
    indexes: [
      { key: { userId: 1 }, options: { name: 'user_unique', unique: true } },
      // Optional: unique only among the profiles that have one.
      { key: { studentNumber: 1 }, options: { name: 'student_number_unique_when_set', unique: true, partialFilterExpression: { studentNumber: { $type: 'string' } } } },
      { key: { academicGroupIds: 1 }, options: { name: 'academic_groups' } },
      { key: { campus: 1 }, options: { name: 'campus' } },
      // Announcements for one UFR or one region: who to notify.
      { key: { ufr: 1 }, options: { name: 'ufr' } },
      { key: { region: 1 }, options: { name: 'region' } },
    ],
  },
];

export const accountsMigrations: DataMigration[] = [
  {
    id: '2026-11-13-explicit-admin-roles',
    description: 'Payments switches, notifications and the team become roles of their own (the super admin role no longer includes them): the current super admins keep them.',
    async up(db) {
      await db.collection('users').updateMany(
        { platformRoles: 'admin', status: { $ne: 'deleted' } },
        { $addToSet: { platformRoles: { $each: ['payments_manager', 'notifications_sender', 'team_manager'] } }, $set: { updatedAt: new Date() } },
      );
    },
  },
  {
    id: '2026-11-06-student-number-optional',
    description: 'The student number becomes optional (added after sign-up): unique only when set; the old unique index goes.',
    async up(db) {
      const profiles = db.collection('studentProfiles');
      const indexes = await profiles.indexes();
      if (indexes.some((ix) => ix.name === 'student_number_unique')) await profiles.dropIndex('student_number_unique');
    },
  },
  {
    id: '2026-10-31-users-email-avatar-location',
    description: 'Give existing users the new optional fields: email, avatar, lastLocation (null).',
    async up(db) {
      const users = db.collection('users');
      for (const field of ['email', 'avatar', 'lastLocation']) await users.updateMany({ [field]: { $exists: false } }, { $set: { [field]: null } });
    },
  },
  {
    id: '2026-11-01-student-profiles-ufr-region',
    description: 'Student profiles get region (null); a UFR stored by name ("UFR SAT") becomes its code ("SAT").',
    async up(db) {
      const profiles = db.collection('studentProfiles');
      await profiles.updateMany({ region: { $exists: false } }, { $set: { region: null } });
      await profiles.updateMany({ ufr: { $exists: false } }, { $set: { ufr: null } });
      for (const code of UFR_CODES) await profiles.updateMany({ ufr: `UFR ${code}` }, { $set: { ufr: code } });
    },
  },
];
