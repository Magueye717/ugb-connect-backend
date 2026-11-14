import type { ObjectId } from 'mongodb';

import type { ImageRef } from '../../platform/media.js';

/** What a student typed themselves (student number, card details by hand) can be corrected this long, then it's locked. */
export const EDIT_WINDOW_DAYS = 3;

/**
 * The app creator's team. Only `admin` (the super admin) gives these roles. content_editor: alerts, "À la une",
 * paid banners · resto_u_staff: the public restaurants' menus (only the restaurants assigned to them) ·
 * place_editor / restaurant_editor / shop_editor: add and update the campus places, private restaurants, shops ·
 * caravan_editor: registers the caravan organizers (transport companies, amicales) and their owner.
 */
export const PLATFORM_ROLES = [
  'admin', 'content_editor', 'resto_u_staff', 'lost_office', 'academic_editor', 'finance', 'place_editor', 'restaurant_editor', 'shop_editor', 'caravan_editor',
  'payments_manager', 'notifications_sender', 'team_manager', 'event_moderator',
] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];
/**
 * Roles the super admin role does NOT include: switching Wave / Orange Money off and on, sending a notification
 * from the back office, managing the UGB Connect team. Each must be given on its own, admin or not.
 */
export const EXPLICIT_ROLES: readonly PlatformRole[] = ['payments_manager', 'notifications_sender', 'team_manager'];
/** How the team list and the notifications name each role. */
export const PLATFORM_ROLE_LABELS: Record<PlatformRole, string> = {
  admin: 'Super administrateur', content_editor: 'Communication (alertes, bannières)', resto_u_staff: 'Restaurant universitaire', lost_office: 'Bureau des objets trouvés',
  academic_editor: 'Scolarité', finance: 'Finances', place_editor: 'Lieux', restaurant_editor: 'Restaurants privés', shop_editor: 'Boutiques', caravan_editor: 'Organisateurs de caravanes',
  payments_manager: 'Paiements (Wave, Orange Money)', notifications_sender: 'Envoi de notifications', team_manager: 'Équipe UGB Connect',
  event_moderator: 'Validation des événements',
};
/**
 * The app's work spaces opened by platform roles (admins open them all). A student keeps the student space as
 * home and reaches these from "Mes espaces"; so does anyone holding several roles.
 */
export const ROLE_SPACES = [
  { space: 'admin', label: 'Administration', roles: ['admin', 'team_manager', 'event_moderator'] },
  { space: 'resto', label: 'Restaurant universitaire', roles: ['resto_u_staff'] },
  { space: 'alerts', label: 'Communication', roles: ['content_editor', 'academic_editor'] },
  { space: 'directory', label: 'Référencement', roles: ['place_editor', 'restaurant_editor', 'shop_editor', 'caravan_editor'] },
] as const satisfies readonly { space: string; label: string; roles: readonly PlatformRole[] }[];
export type RoleSpace = (typeof ROLE_SPACES)[number]['space'];
/** The kind of a space; an organization's spaces also carry the organization (one entity may run several). */
export type AppSpaceType = 'student' | 'organizer' | 'business' | RoleSpace;
/** `personal`: a student's own entity (their shop, their events). */
export type AppSpace = { key: string; type: AppSpaceType; kind: 'restaurant' | 'shop' | null; orgId: string | null; name: string; roles: string[]; logoUrl: string | null; personal: boolean };

export const CAMPUSES = ['campus1', 'campus2'] as const;
export type Campus = (typeof CAMPUSES)[number];

/**
 * UGB's villages. Campus I (shared rooms, mostly undergraduates): A to G, M, P, Q. Campus II (individual rooms,
 * mostly postgraduates): H to L, N, O. The app reads them from GET /reference/student.
 */
export const VILLAGES: Record<Campus, string[]> = {
  campus1: ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'M', 'P', 'Q'].map((v) => `Village ${v}`),
  campus2: ['H', 'I', 'J', 'K', 'L', 'N', 'O'].map((v) => `Village ${v}`),
};
export const CAMPUS_LABELS: Record<Campus, string> = { campus1: 'Campus 1', campus2: 'Campus 2' };

/** UGB's UFRs: the code is what's stored (and targeted by announcements). */
export const UFRS = [
  { code: 'SAT', name: 'Sciences appliquées et technologie' },
  { code: 'LSH', name: 'Lettres et sciences humaines' },
  { code: 'SJP', name: 'Sciences juridiques et politiques' },
  { code: 'SEG', name: 'Sciences économiques et de gestion' },
  { code: 'S2ATA', name: 'Sciences agronomiques, aquaculture et technologies alimentaires' },
  { code: '2S', name: 'Santé' },
  { code: 'SEFS', name: 'Sciences de l’éducation, de la formation et du sport' },
  { code: 'CRAC', name: 'Civilisations, religions, arts et communication' },
] as const;
export type UfrCode = (typeof UFRS)[number]['code'];
export const UFR_CODES = UFRS.map((u) => u.code) as UfrCode[];

/** Where the student comes from: Senegal's 14 regions, or abroad. */
export const REGIONS = [
  'Dakar', 'Diourbel', 'Fatick', 'Kaffrine', 'Kaolack', 'Kédougou', 'Kolda', 'Louga', 'Matam', 'Saint-Louis', 'Sédhiou', 'Tambacounda', 'Thiès', 'Ziguinchor',
  'Hors Sénégal',
] as const;
export type Region = (typeof REGIONS)[number];

/** The year of study, asked with the UFR (it changes at each rentrée). */
export const NIVEAUX = ['Licence 1', 'Licence 2', 'Licence 3', 'Master 1', 'Master 2', 'Doctorat'] as const;
export type Niveau = (typeof NIVEAUX)[number];

/**
 * Who an announcement is for. Each list narrows (empty: no restriction); all empty: the whole university.
 * Lists combine: UFR SAT + Campus 1 = SAT students living on Campus 1.
 */
export type Audience = { campuses: Campus[]; ufrs: UfrCode[]; regions: Region[] };
/** What a viewer is matched on: null for accounts without a student profile (they see whole-university items only). */
export type AudienceProfile = { campus: Campus; ufr: UfrCode | null; region: Region | null; village?: string | null } | null;

/** A student number: P then at least 4 digits (« P1234 »), 20 characters at most; spaces removed, upper-cased first. */
export const STUDENT_NUMBER_MAX = 20;
export const STUDENT_NUMBER_RE = /^P\d{4,19}$/;
/**
 * What the database accepts: the previous rule (P then 3 digits or more). Numbers saved under it stay valid (their
 * accounts can still be updated), and the deploy doesn't have to rewrite the collection's validator.
 */
export const STORED_STUDENT_NUMBER_RE = /^P\d{3,19}$/;
export const ROOM_RE = /^[A-Z]?\d{1,4}[A-Z]?$/;
export const NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ]+(?:[ '-][A-Za-zÀ-ÖØ-öø-ÿ]+)*$/;

/** `campus` (restos, campus alerts) came later: missing means on. */
export type NotificationPrefs = { social: boolean; cours: boolean; paiements: boolean; campus?: boolean };

export type UserDoc = {
  _id: ObjectId;
  /** E.164, the account identity (decision Q-6). */
  phone: string;
  phoneVerifiedAt: Date | null;
  /** Null for accounts created by an admin (organizers) until they set one through "mot de passe oublié". */
  passwordHash: string | null;
  firstName: string;
  lastName: string;
  status: 'active' | 'suspended' | 'deleted';
  platformRoles: PlatformRole[];
  /** resto_u_staff: the public restaurants this person publishes menus for (assigned by the super admin). */
  restoIds?: ObjectId[];
  login: { failedCount: number; lockedUntil: Date | null; lastLoginAt: Date | null };
  terms: { version: string; acceptedAt: Date } | null;
  notificationPrefs: NotificationPrefs;
  /** Wave / Orange Money number that receives refunds and payouts (decision Q-1): the login phone by default. */
  payoutAccount: { phone: string; verifiedAt: Date };
  /** Added after sign-up, optional. Not a login identifier; verified once an e-mail provider exists (Q-14). */
  email: { address: string; verifiedAt: Date | null; addedAt: Date } | null;
  /** Profile picture, set through the media module (never a client-supplied URL). */
  avatar: ImageRef | null;
  /**
   * Last position the app reported, for future features. Personal data: only ever shown to the user themself,
   * sent by the app only with the location permission granted, removable at any time.
   */
  lastLocation: { point: { type: 'Point'; coordinates: [lng: number, lat: number] }; accuracyM: number | null; updatedAt: Date } | null;
  createdAt: Date;
  updatedAt: Date;
};

export type StudentProfileDoc = {
  _id: ObjectId;
  userId: ObjectId;
  /**
   * Optional at sign-up (added later on the profile, or read from the student's card); unique once set, not verified
   * against a registry (decision Q-6).
   */
  studentNumber: string | null;
  /** When it was first given (sign-up, profile, card): correctable for EDIT_WINDOW_DAYS, then the team's call. Missing: `createdAt`. */
  studentNumberSetAt?: Date | null;
  campus: Campus;
  onCampus: boolean;
  village: string | null;
  room: string | null;
  /** UFR code (UFRS). Asked at sign-up; null for accounts created before. */
  ufr: UfrCode | null;
  /** Home region (REGIONS). Asked at sign-up; null for accounts created before. */
  region: Region | null;
  /** When the UFR or region was last given (sign-up, profile): unchanged until the next rentrée. Missing: `createdAt`. */
  originSetAt?: Date | null;
  filiere: string | null;
  niveau: string | null;
  /**
   * Birth date ("2002-03-12"), place of birth and nationality: optional, given by the student, best read from their
   * own student card (`source: 'card'`). Missing on older profiles.
   */
  identity?: { birthDate: string | null; birthPlace: string | null; nationality: string | null; source: 'card' | 'manual'; updatedAt: Date; /** Typed by hand: when first given (correctable EDIT_WINDOW_DAYS). */ firstSetAt?: Date } | null;
  /** When the student's own card was last read and matched their student number: saving the identity needs a recent one. */
  cardReadAt?: Date | null;
  academicGroupIds: ObjectId[];
  verification: { status: 'unverified' | 'verified'; verifiedAt: Date | null };
  createdAt: Date;
  updatedAt: Date;
};

export type NewStudentAccount = {
  phone: string;
  studentNumber: string | null;
  firstName: string;
  lastName: string;
  campus: Campus;
  onCampus: boolean;
  village: string | null;
  room: string | null;
  ufr: UfrCode | null;
  region: Region | null;
  niveau?: Niveau | null;
  passwordHash: string;
  termsVersion: string;
};

/** What /me needs from the organizations module (wired in the container: no import of that module here). */
/** One space of an organization the user works in (`space`: organizer, restaurant or shop). */
export type MembershipSummary = { orgId: string; name: string; category: string; level: string; roles: string[]; capabilities: string[]; space: 'organizer' | 'restaurant' | 'shop'; logoUrl: string | null };
export interface OrganizationsPort {
  membershipsForUser(userId: ObjectId): Promise<MembershipSummary[]>;
}
