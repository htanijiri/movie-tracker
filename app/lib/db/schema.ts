import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// 値の種類。BRIEF にある将来分（INTERESTED、RENTAL、ANY）も入れ物として用意しておき、
// Phase 1 の画面ではその一部だけを使う。
export const STATUSES = [
  "INTERESTED",
  "WANT_TO_WATCH",
  "WATCHED",
  "SKIPPED",
] as const;
export const PREFERRED_MEDIUMS = [
  "THEATER",
  "STREAMING",
  "RENTAL",
  "ANY",
  "NONE",
] as const;
export const DISCOVERY_TYPES = [
  "THEATER_TRAILER",
  "TV_CM",
  "WEB_CM",
  "SNS",
  "ARTICLE",
  "FRIEND",
  "OTHER",
] as const;
export const WATCHED_MEDIUMS = [
  "THEATER",
  "STREAMING",
  "RENTAL",
  "OTHER",
] as const;

export type Status = (typeof STATUSES)[number];
export type PreferredMedium = (typeof PREFERRED_MEDIUMS)[number];
export type DiscoveryType = (typeof DISCOVERY_TYPES)[number];
export type WatchedMedium = (typeof WATCHED_MEDIUMS)[number];

const inList = (values: readonly string[]) =>
  sql.raw(values.map((v) => `'${v}'`).join(", "));

// 利用者。Google ログインで初めて入ったときに作る。
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull(),
  name: text("name"),
  createdAt: text("created_at").notNull(),
});

// 映画の情報のスナップショット。一覧で TMDb を呼ばずにタイトルとポスターを出すための最小限だけを持つ。
// TMDb の利用条件（長期間の保持の禁止）に合わせ、古いものは詳細を開いたときに取り直す。
export const movies = sqliteTable("movies", {
  tmdbId: integer("tmdb_id").primaryKey(),
  title: text("title").notNull(),
  originalTitle: text("original_title"),
  releaseDate: text("release_date"),
  posterPath: text("poster_path"),
  fetchedAt: text("fetched_at").notNull(),
});

// 利用者と映画の関係（見たい・きっかけ・見た記録）。1人の利用者につき、1本の映画に1行。
export const userMovies = sqliteTable(
  "user_movies",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tmdbId: integer("tmdb_id")
      .notNull()
      .references(() => movies.tmdbId),

    status: text("status", { enum: STATUSES }).notNull(),
    preferredMedium: text("preferred_medium", { enum: PREFERRED_MEDIUMS }),

    discoveryType: text("discovery_type", { enum: DISCOVERY_TYPES }),
    discoveryDate: text("discovery_date"),
    discoveryPlace: text("discovery_place"),
    discoveryNote: text("discovery_note"),

    watchedAt: text("watched_at"),
    watchedMedium: text("watched_medium", { enum: WATCHED_MEDIUMS }),
    watchedPlace: text("watched_place"),
    rating: integer("rating"),
    review: text("review"),

    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("user_movies_user_tmdb_unique").on(t.userId, t.tmdbId),
    index("user_movies_user_status_medium_idx").on(
      t.userId,
      t.status,
      t.preferredMedium,
    ),
    index("user_movies_user_watched_at_idx").on(t.userId, t.watchedAt),
    check("user_movies_status_check", sql`${t.status} IN (${inList(STATUSES)})`),
    check(
      "user_movies_preferred_medium_check",
      sql`${t.preferredMedium} IS NULL OR ${t.preferredMedium} IN (${inList(PREFERRED_MEDIUMS)})`,
    ),
    check(
      "user_movies_discovery_type_check",
      sql`${t.discoveryType} IS NULL OR ${t.discoveryType} IN (${inList(DISCOVERY_TYPES)})`,
    ),
    check(
      "user_movies_watched_medium_check",
      sql`${t.watchedMedium} IS NULL OR ${t.watchedMedium} IN (${inList(WATCHED_MEDIUMS)})`,
    ),
    check(
      "user_movies_rating_check",
      sql`${t.rating} IS NULL OR (${t.rating} BETWEEN 1 AND 5)`,
    ),
  ],
);

export type User = typeof users.$inferSelect;
export type Movie = typeof movies.$inferSelect;
export type UserMovie = typeof userMovies.$inferSelect;
