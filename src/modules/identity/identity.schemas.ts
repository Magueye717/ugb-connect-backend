import { Type } from 'typebox';

import { ObjectIdString, PhoneInput } from '../../platform/http/schemas.js';
import { CampusSchema, NiveauInput, RegionInput, UfrInput } from '../accounts/index.js';

const Channel = Type.Union([Type.Literal('sms'), Type.Literal('whatsapp'), Type.Literal('email')]);
const Purpose = Type.Union([Type.Literal('register'), Type.Literal('reset_password'), Type.Literal('change_phone')]);
const Password = Type.String({ minLength: 1, maxLength: 200 });
const Device = Type.Object(
  { id: Type.Optional(Type.String({ maxLength: 100 })), platform: Type.Optional(Type.String({ maxLength: 20 })), appVersion: Type.Optional(Type.String({ maxLength: 20 })) },
  { additionalProperties: false },
);

export const TokensSchema = Type.Object({
  accessToken: Type.String(),
  accessTokenExpiresAt: Type.String(),
  refreshToken: Type.String(),
  refreshTokenExpiresAt: Type.String(),
});

export const CheckBody = Type.Object({ phone: PhoneInput, studentNumber: Type.Optional(Type.Union([Type.String({ maxLength: 30 }), Type.Null()], { description: 'Optional: checked only when given.' })) }, { additionalProperties: false });
export const CheckResponse = Type.Object({
  available: Type.Boolean(),
  conflict: Type.Optional(Type.Union([Type.Literal('phone'), Type.Literal('student_number')])),
  /** The number has an account that isn't a student's (a team member): sign-up completes it, its roles stay. */
  existingAccount: Type.Optional(Type.Boolean()),
});

export const OtpBody = Type.Object({ phone: PhoneInput, purpose: Purpose, channel: Type.Optional(Channel) }, { additionalProperties: false });
export const ChallengeResponse = Type.Object({
  challengeId: Type.String(), expiresIn: Type.Number(), resendAfter: Type.Number(), codeLength: Type.Number(),
  devCode: Type.Optional(Type.String({ description: 'Development only (OTP_DEV_MODE): the fixed code. Never present in production.' })),
});
export const ChallengeParams = Type.Object({ challengeId: ObjectIdString }, { additionalProperties: false });
export const ResendBody = Type.Object({ channel: Type.Optional(Channel) }, { additionalProperties: false });
export const VerifyBody = Type.Object({ code: Type.String({ minLength: 4, maxLength: 8, pattern: '^[0-9]+$' }) }, { additionalProperties: false });
export const VerifyResponse = Type.Object({ verificationToken: Type.String() });

export const RegisterBody = Type.Object(
  {
    verificationToken: Type.String({ minLength: 10, maxLength: 2000 }),
    studentNumber: Type.Optional(Type.Union([Type.String({ maxLength: 30 }), Type.Null()], { description: 'Optional (added later on the profile): P then digits, 12 characters at most once spaces are removed.' })),
    firstName: Type.String({ minLength: 1, maxLength: 60 }),
    lastName: Type.String({ minLength: 1, maxLength: 60 }),
    campus: CampusSchema,
    onCampus: Type.Boolean(),
    village: Type.Optional(Type.Union([Type.String({ maxLength: 40 }), Type.Null()])),
    room: Type.Optional(Type.Union([Type.String({ maxLength: 8 }), Type.Null()])),
    ufr: UfrInput,
    niveau: Type.Optional(NiveauInput),
    region: RegionInput,
    password: Password,
    termsVersion: Type.String({ minLength: 1, maxLength: 20 }),
    device: Type.Optional(Device),
  },
  { additionalProperties: false },
);

export const LoginBody = Type.Object(
  { identifier: Type.String({ minLength: 1, maxLength: 30 }), password: Password, device: Type.Optional(Device) },
  { additionalProperties: false },
);
export const RefreshBody = Type.Object({ refreshToken: Type.String({ minLength: 20, maxLength: 200 }) }, { additionalProperties: false });
export const ResetBody = Type.Object({ verificationToken: Type.String({ minLength: 10, maxLength: 2000 }), newPassword: Password }, { additionalProperties: false });
export const ChangePasswordBody = Type.Object({ currentPassword: Password, newPassword: Password }, { additionalProperties: false });
