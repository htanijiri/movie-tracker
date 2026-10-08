import { getSecret, hasSecret } from "~/lib/env.server";

// 開発サーバーで ALLOWED_EMAILS を設定していないときに使う、開発用ログインのメールアドレス。
export const DEV_EMAIL = "dev@example.com";

/** このアプリを使ってよいメールアドレス（小文字にそろえたもの）。 */
export function getAllowedEmails(): string[] {
  if (!hasSecret("ALLOWED_EMAILS")) {
    if (import.meta.env.DEV) return [DEV_EMAIL];
    // 本番で未設定のときは、誰も入れないようにする。
    return [];
  }
  return getSecret("ALLOWED_EMAILS")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email !== "");
}

export function isAllowedEmail(email: string): boolean {
  return getAllowedEmails().includes(email.trim().toLowerCase());
}
