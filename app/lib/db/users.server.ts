import { eq } from "drizzle-orm";

import { nowIso } from "~/lib/date";

import type { Db } from "./client.server";
import { users, type User } from "./schema";

/**
 * Google の利用者番号（sub）で利用者を探し、いなければ作る。
 * メールアドレスや名前が変わっていたら更新する。
 */
export async function findOrCreateUser(
  db: Db,
  profile: { sub: string; email: string; name: string | null },
): Promise<User> {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.googleSub, profile.sub))
    .get();

  if (existing) {
    if (existing.email !== profile.email || existing.name !== profile.name) {
      await db
        .update(users)
        .set({ email: profile.email, name: profile.name })
        .where(eq(users.id, existing.id));
      return { ...existing, email: profile.email, name: profile.name };
    }
    return existing;
  }

  const user: User = {
    id: crypto.randomUUID(),
    googleSub: profile.sub,
    email: profile.email,
    name: profile.name,
    createdAt: nowIso(),
  };
  await db.insert(users).values(user);
  return user;
}
