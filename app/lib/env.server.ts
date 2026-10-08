import { env } from "cloudflare:workers";

// 秘密情報の設定キー。手元は .dev.vars、本番は Workers のシークレットから読む。
// キーを増やしたら .dev.vars.example と docs/DEPLOY.md も揃える。
export const SECRET_KEYS = [
  "TMDB_ACCESS_TOKEN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_EMAILS",
  "SESSION_SECRET",
] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

export function getSecret(key: SecretKey): string {
  const value = (env as unknown as Record<string, unknown>)[key];
  if (typeof value !== "string" || value === "") {
    // 値そのものは出さず、どのキーが足りないかだけを伝える。
    throw new Error(
      `設定 ${key} がありません。手元では .dev.vars、本番では Workers のシークレットに登録してください（.dev.vars.example を参照）。`,
    );
  }
  return value;
}

export function hasSecret(key: SecretKey): boolean {
  const value = (env as unknown as Record<string, unknown>)[key];
  return typeof value === "string" && value !== "";
}
