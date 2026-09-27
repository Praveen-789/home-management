// How a person looks to the app, wherever they appear: as a task's creator, an expense's payer, a
// household member, a chat sender. Every service selects people through this file, so a new public
// field such as the avatar reaches every screen at once. Passwords and Google IDs are never listed.
export const userFields = { id: true, name: true, email: true, avatarUrl: true } as const;

// The same fields, shaped for a relation: `createdBy: userSummary`.
export const userSummary = { select: userFields } as const;

// Chat shows people without their email address.
export const chatUserSummary = { select: { id: true, name: true, avatarUrl: true } } as const;
