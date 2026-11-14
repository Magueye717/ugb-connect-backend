import { ObjectId, type ClientSession, type Collection, type Db } from 'mongodb';

import type { NotificationPrefs, PlatformRole, StudentProfileDoc, UserDoc } from './accounts.types.js';

/** The only code that touches `users` and `studentProfiles`. */
export class AccountsRepository {
  readonly users: Collection<UserDoc>;
  readonly profiles: Collection<StudentProfileDoc>;

  constructor(db: Db) {
    this.users = db.collection<UserDoc>('users');
    this.profiles = db.collection<StudentProfileDoc>('studentProfiles');
  }

  /** Students on the platform, and those who signed up since `since` (the team's dashboard). */
  async countStudents(since: Date) {
    const [total, since_] = await Promise.all([this.profiles.countDocuments({}), this.profiles.countDocuments({ createdAt: { $gte: since } })]);
    return { total, since: since_ };
  }

  insertUser(doc: UserDoc, session?: ClientSession) {
    return this.users.insertOne(doc, { session });
  }

  insertProfile(doc: StudentProfileDoc, session?: ClientSession) {
    return this.profiles.insertOne(doc, { session });
  }

  findUserById(id: ObjectId) {
    return this.users.findOne({ _id: id, status: { $ne: 'deleted' } });
  }

  findUsersByIds(ids: ObjectId[]) {
    return this.users.find({ _id: { $in: ids } }, { projection: { firstName: 1, lastName: 1, status: 1 } }).toArray();
  }

  findPrefsByIds(ids: ObjectId[]) {
    return this.users.find({ _id: { $in: ids } }, { projection: { notificationPrefs: 1 } }).toArray();
  }

  findContactsByIds(ids: ObjectId[]) {
    return this.users.find({ _id: { $in: ids } }, { projection: { firstName: 1, lastName: 1, phone: 1 } }).toArray();
  }

  findUserByPhone(phone: string, session?: ClientSession) {
    return this.users.findOne({ phone, status: { $ne: 'deleted' } }, { session });
  }

  findProfileByUserId(userId: ObjectId, session?: ClientSession) {
    return this.profiles.findOne({ userId }, { session });
  }

  /** A team member becoming a student: the fields sign-up sets on the account it completes. */
  completeAsStudent(userId: ObjectId, set: Pick<UserDoc, 'firstName' | 'lastName' | 'passwordHash' | 'phoneVerifiedAt' | 'terms' | 'login' | 'updatedAt'>, session: ClientSession) {
    return this.users.findOneAndUpdate({ _id: userId }, { $set: set }, { session, returnDocument: 'after' });
  }

  findProfileByStudentNumber(studentNumber: string) {
    return this.profiles.findOne({ studentNumber });
  }

  findProfilesByUserIds(userIds: ObjectId[]) {
    return this.profiles.find({ userId: { $in: userIds } }).toArray();
  }

  /** Active accounts whose first or last name matches one of these patterns. */
  findUsersByNames(patterns: RegExp[], limit: number) {
    return this.users
      .find({ status: 'active', $or: [{ firstName: { $in: patterns } }, { lastName: { $in: patterns } }] }, { projection: { firstName: 1, lastName: 1, phone: 1 } })
      .limit(limit)
      .toArray();
  }

  async phoneExists(phone: string) {
    return (await this.users.countDocuments({ phone }, { limit: 1 })) > 0;
  }

  async studentNumberExists(studentNumber: string) {
    return (await this.profiles.countDocuments({ studentNumber }, { limit: 1 })) > 0;
  }

  /** Counts a failed password and returns the new count; the lock itself is decided by the service. */
  async incrementLoginFailures(userId: ObjectId, now: Date) {
    const res = await this.users.findOneAndUpdate(
      { _id: userId },
      { $inc: { 'login.failedCount': 1 }, $set: { updatedAt: now } },
      { returnDocument: 'after', projection: { 'login.failedCount': 1 } },
    );
    return res?.login.failedCount ?? 0;
  }

  setLockedUntil(userId: ObjectId, until: Date) {
    return this.users.updateOne({ _id: userId }, { $set: { 'login.lockedUntil': until } });
  }

  recordLoginSuccess(userId: ObjectId, now: Date) {
    return this.users.updateOne({ _id: userId }, { $set: { 'login.failedCount': 0, 'login.lockedUntil': null, 'login.lastLoginAt': now, updatedAt: now } });
  }

  setPassword(userId: ObjectId, passwordHash: string, now: Date, session?: ClientSession) {
    return this.users.updateOne(
      { _id: userId },
      { $set: { passwordHash, 'login.failedCount': 0, 'login.lockedUntil': null, updatedAt: now } },
      { session },
    );
  }

  /** Students an announcement is for (see Audience): their user ids, in batches by the caller. */
  async userIdsMatching(filter: Record<string, unknown>) {
    return (await this.profiles.find(filter, { projection: { userId: 1 } }).toArray()).map((p) => p.userId);
  }

  updateProfile(userId: ObjectId, patch: Partial<Pick<StudentProfileDoc, 'campus' | 'onCampus' | 'village' | 'room' | 'ufr' | 'region' | 'originSetAt' | 'identity' | 'cardReadAt'>>, now: Date) {
    return this.profiles.findOneAndUpdate({ userId }, { $set: { ...patch, updatedAt: now } }, { returnDocument: 'after' });
  }

  setNotificationPrefs(userId: ObjectId, prefs: NotificationPrefs, now: Date) {
    return this.users.updateOne({ _id: userId }, { $set: { notificationPrefs: prefs, updatedAt: now } });
  }

  /** A new login number; refunds and payouts follow it when they went to the old one. */
  setPhone(userId: ObjectId, phone: string, payoutToo: boolean, now: Date) {
    return this.users.updateOne({ _id: userId }, { $set: { phone, phoneVerifiedAt: now, ...(payoutToo ? { 'payoutAccount.phone': phone } : {}), updatedAt: now } });
  }

  /** Self-service fields of the user document (e-mail, location). */
  setUserFields(userId: ObjectId, fields: Partial<Pick<UserDoc, 'email' | 'lastLocation' | 'avatar'>>, now: Date) {
    return this.users.updateOne({ _id: userId }, { $set: { ...fields, updatedAt: now } });
  }

  setPlatformRoles(userId: ObjectId, roles: PlatformRole[], now: Date) {
    return this.users.findOneAndUpdate({ _id: userId }, { $set: { platformRoles: roles, updatedAt: now } }, { returnDocument: 'after' });
  }

  newId() {
    return new ObjectId();
  }
}
