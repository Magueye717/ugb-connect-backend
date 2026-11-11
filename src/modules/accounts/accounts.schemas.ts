import { Type } from 'typebox';

import { Nullable, PhoneInput } from '../../platform/http/schemas.js';
import { NIVEAUX, CAMPUSES, PLATFORM_ROLES, REGIONS, UFR_CODES } from './accounts.types.js';


export const MeResponse = Type.Object({
  id: Type.String(),
  firstName: Type.String(),
  lastName: Type.String(),
  initials: Type.String(),
  phoneMasked: Type.String(),
  platformRoles: Type.Array(Type.String()),
  student: Nullable(
    Type.Object({
      studentNumber: Nullable(Type.String({ description: 'Null until the student gives it (profile, or their card).' })),
      campus: Type.String(),
      onCampus: Type.Boolean(),
      village: Nullable(Type.String()),
      room: Nullable(Type.String()),
      ufr: Nullable(Type.String({ description: 'UFR code (GET /reference/student).' })),
      region: Nullable(Type.String({ description: 'Home region (GET /reference/student).' })),
      filiere: Nullable(Type.String()),
      niveau: Nullable(Type.String()),
      verified: Type.Boolean(),
      identity: Nullable(
        Type.Object(
          { birthDate: Nullable(Type.String({ description: 'YYYY-MM-DD' })), birthPlace: Nullable(Type.String()), nationality: Nullable(Type.String()), fromCard: Type.Boolean(), updatedAt: Type.String() },
          { description: 'Optional; best read from the student’s own card (POST /me/student-card/read).' },
        ),
      ),
      originEditableFrom: Nullable(Type.String({ description: 'UFR and region given this academic year: the filled ones change from this date (the next rentrée). Null: free to change.' })),
      identityEditableFrom: Nullable(Type.String({ description: 'Card details saved this academic year: the filled ones change from this date (the next rentrée). Null: free to change.' })),
      studentNumberEditableUntil: Nullable(Type.String({ description: 'The student number can still be corrected until then (3 days after it was first given). Null: locked, or none.' })),
      identityEditableUntil: Nullable(Type.String({ description: 'Card details typed by hand: correctable until then (3 days after first given). Null: locked, from the card, or none.' })),
    }),
  ),
  /** Drives AuthContext.spaces in the app. */
  spaces: Type.Array(
    Type.Object({
      key: Type.String({ description: '"student", "restaurant:<orgId>", "shop:<orgId>", "organizer:<orgId>", "admin", "resto", "alerts", "directory": what /espace opens.' }),
      type: Type.Union([Type.Literal('student'), Type.Literal('organizer'), Type.Literal('business'), Type.Literal('admin'), Type.Literal('resto'), Type.Literal('alerts'), Type.Literal('directory')]),
      kind: Nullable(Type.Union([Type.Literal('restaurant'), Type.Literal('shop')])),
      orgId: Nullable(Type.String()),
      name: Type.String({ description: 'The organization (Khoulé & frère) or the space (Administration).' }),
      roles: Type.Array(Type.String()),
      logoUrl: Nullable(Type.String()),
      personal: Type.Boolean({ description: 'A student’s own entity (their shop, their events).' }),
    }),
    { description: 'Spaces the app can open, the first being home. One per space of each organization: an entity may run a restaurant, a shop and caravans.' },
  ),
  organizations: Type.Array(Type.Object({ id: Type.String(), name: Type.String(), category: Type.String(), level: Type.String(), roles: Type.Array(Type.String()), capabilities: Type.Array(Type.String()), space: Type.String() })),
  payoutPhoneMasked: Type.String(),
  email: Nullable(Type.Object({ address: Type.String(), verified: Type.Boolean() })),
  /** Null until the media module ships (profile picture upload). */
  avatarUrl: Nullable(Type.String()),
  location: Nullable(Type.Object({ lat: Type.Number(), lng: Type.Number(), accuracyM: Nullable(Type.Number()), updatedAt: Type.String() })),
});

export const IdentityBody = Type.Object(
  {
    birthDate: Nullable(Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
    birthPlace: Nullable(Type.String({ maxLength: 60 })),
    nationality: Nullable(Type.String({ maxLength: 40 })),
    fromCard: Type.Optional(Type.Boolean({ description: 'Read from the student card (then checked by the student).' })),
  },
  { additionalProperties: false },
);

export const EmailBody = Type.Object({ email: Type.String({ minLength: 3, maxLength: 254 }) }, { additionalProperties: false });

export const LocationBody = Type.Object(
  {
    lat: Type.Number({ minimum: -90, maximum: 90 }),
    lng: Type.Number({ minimum: -180, maximum: 180 }),
    /** Accuracy radius reported by the phone, in metres. */
    accuracyM: Type.Optional(Type.Number({ minimum: 0, maximum: 100_000 })),
  },
  { additionalProperties: false },
);

export const ResidenceBody = Type.Object(
  { campus: Type.Optional(Type.Enum(CAMPUSES)), onCampus: Type.Boolean(), village: Type.Optional(Nullable(Type.String({ maxLength: 40 }))), room: Type.Optional(Nullable(Type.String({ maxLength: 8 }))) },
  { additionalProperties: false },
);

export const UfrInput = Type.Union(UFR_CODES.map((c) => Type.Literal(c)), { description: 'UFR code: GET /reference/student.' });
export const RegionInput = Type.Union(REGIONS.map((r) => Type.Literal(r)), { description: 'Home region: GET /reference/student.' });
export const NiveauInput = Type.Union(NIVEAUX.map((n) => Type.Literal(n)), { description: 'Year of study.' });
/** Each one alone (« Mon UFR et mon niveau », the région on « Ma carte étudiant »): what isn't sent stays. */
export const OriginBody = Type.Object({ ufr: Type.Optional(UfrInput), region: Type.Optional(RegionInput), niveau: Type.Optional(NiveauInput) }, { additionalProperties: false, minProperties: 1 });

export const StudentReference = Type.Object({
  campuses: Type.Array(Type.Object({ key: Type.String(), label: Type.String(), villages: Type.Array(Type.String()) })),
  ufrs: Type.Array(Type.Object({ code: Type.String(), name: Type.String() })),
  regions: Type.Array(Type.String()),
  studentNumber: Type.Object({ pattern: Type.String({ description: 'Checked once spaces are removed and letters upper-cased.' }), maxLength: Type.Integer(), example: Type.String() }),
});

export const NotificationPrefsSchema = Type.Object(
  { social: Type.Boolean(), cours: Type.Boolean(), paiements: Type.Boolean(), campus: Type.Optional(Type.Boolean({ description: 'Restos publics, alertes du campus. Default true.' })) },
  { additionalProperties: false },
);

export const CreateStaffUserBody = Type.Object(
  { phone: PhoneInput, firstName: Type.String({ minLength: 1, maxLength: 60 }), lastName: Type.String({ minLength: 1, maxLength: 60 }) },
  { additionalProperties: false },
);

export const PlatformRolesBody = Type.Object(
  { roles: Type.Array(Type.Enum(PLATFORM_ROLES), { maxItems: PLATFORM_ROLES.length }) },
  { additionalProperties: false },
);

export const CampusSchema = Type.Enum(CAMPUSES);
