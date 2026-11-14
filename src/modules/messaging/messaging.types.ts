import type { ObjectId } from 'mongodb';

/**
 * Every feature that has conversations. Messaging knows nothing about taxis or lost items: the owning module
 * creates the conversation, keeps its member list up to date and posts system lines.
 */
export const CONVERSATION_TYPES = ['taxi_trip', 'lost_claim', 'housing_contact'] as const;
export type ConversationType = (typeof CONVERSATION_TYPES)[number];

/**
 * How someone appears in a conversation, decided by the owning module: a pseudonymous key (never a user id),
 * a display name ("Moussa S."), initials and a role label ("organizer"…).
 */
export type MemberIdentity = { key: string; name: string; initials: string; role: string | null };

export type ConversationMember = MemberIdentity & {
  userId: ObjectId;
  /** Readers who can't write: e.g. a passenger who left after the lock still sees the chat. */
  canWrite: boolean;
};

export type ConversationDoc = {
  _id: ObjectId;
  type: ConversationType;
  /** The trip, the claim…: unique with `type`. */
  contextRef: ObjectId;
  title: string;
  /** The app screen of this chat ("/trajet/…"), opened from a push notification. Set by the owning module. */
  url: string | null;
  /** Who may read. Replaced as a whole by the owning module whenever it changes. Bounded (≤ 8 for a taxi). */
  members: ConversationMember[];
  /** Nobody writes after this (taxi: 2 h after departure). Reading stays possible. */
  writableUntil: Date | null;
  status: 'open' | 'closed';
  lastMessageId: ObjectId | null;
  lastMessageAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export const MESSAGE_KINDS = ['text', 'quick_reply', 'system'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export type MessageDoc = {
  _id: ObjectId;
  conversationId: ObjectId;
  /** Snapshot at writing time, so a message keeps its author after they leave. Null for system lines. */
  author: (MemberIdentity & { userId: ObjectId }) | null;
  kind: MessageKind;
  body: string;
  /** Set by the app: a retried send returns the first message instead of posting twice. */
  clientMessageId: string | null;
  createdAt: Date;
};

export type ConversationReadDoc = { _id: ObjectId; conversationId: ObjectId; userId: ObjectId; lastReadMessageId: ObjectId; updatedAt: Date };

/** Blocking is per person, across every conversation and feature. */
export type UserBlockDoc = { _id: ObjectId; userId: ObjectId; blockedUserId: ObjectId; createdAt: Date };

export type MessageReportDoc = {
  _id: ObjectId;
  messageId: ObjectId;
  conversationId: ObjectId;
  conversationType: ConversationType;
  reporterId: ObjectId;
  authorId: ObjectId;
  /** Copy of the message, kept for review even if retention deletes the conversation. */
  body: string;
  reason: string | null;
  status: 'open' | 'reviewed';
  createdAt: Date;
};

export const MESSAGE_MAX_LENGTH = 500;
