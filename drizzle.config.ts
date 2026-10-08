import { defineConfig } from "drizzle-kit";

// スキーマから SQL のマイグレーションを生成するための設定。
// 生成した SQL は `wrangler d1 migrations apply` で適用する（drizzle-kit から DB には接続しない）。
export default defineConfig({
  dialect: "sqlite",
  schema: "./app/lib/db/schema.ts",
  out: "./migrations",
});
