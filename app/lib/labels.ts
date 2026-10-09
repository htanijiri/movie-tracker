import type {
  DiscoveryType,
  PreferredMedium,
  Status,
  WatchedMedium,
} from "./db/schema";

// 画面に出す日本語のラベル。値の種類は db/schema.ts と揃える。

export const DISCOVERY_TYPE_LABELS: Record<DiscoveryType, string> = {
  THEATER_TRAILER: "映画館の予告",
  TV_CM: "CM",
  WEB_CM: "Web広告",
  SNS: "SNS",
  ARTICLE: "記事",
  FRIEND: "人から聞いた",
  OTHER: "その他",
};

export const WATCHED_MEDIUM_LABELS: Record<WatchedMedium, string> = {
  THEATER: "劇場",
  STREAMING: "サブスク配信",
  RENTAL: "レンタル・購入",
  OTHER: "その他",
};

// 一覧のカードに出す、「どこで見たか」の短いラベル（仕様書 008）。
export const WATCHED_MEDIUM_BADGES: Record<
  WatchedMedium,
  { emoji: string; label: string }
> = {
  THEATER: { emoji: "🎬", label: "劇場" },
  STREAMING: { emoji: "📺", label: "サブスク" },
  RENTAL: { emoji: "💿", label: "レンタル・購入" },
  OTHER: { emoji: "📍", label: "その他" },
};

// Phase 1 の画面で選べる「どこまでなら見たいか」。
export const SELECTABLE_MEDIUMS = ["THEATER", "STREAMING", "NONE"] as const;
export type SelectableMedium = (typeof SELECTABLE_MEDIUMS)[number];

// parts は、狭い画面で改行してよい位置で区切ったもの（つなげると label になる）。
export const MEDIUM_BUTTON_LABELS: Record<
  SelectableMedium,
  { emoji: string; label: string; parts: string[] }
> = {
  THEATER: { emoji: "🎬", label: "劇場で見たい", parts: ["劇場で", "見たい"] },
  STREAMING: { emoji: "📺", label: "サブスクで見たい", parts: ["サブスクで", "見たい"] },
  NONE: { emoji: "❌", label: "見送る", parts: ["見送る"] },
};

export type StateKey = "theater" | "streaming" | "watched" | "skipped" | "other";

export const STATE_LABELS: Record<StateKey, { emoji: string; label: string }> = {
  theater: { emoji: "🎬", label: "劇場で見たい" },
  streaming: { emoji: "📺", label: "サブスク待ち" },
  watched: { emoji: "✅", label: "視聴済み" },
  skipped: { emoji: "❌", label: "見送り" },
  other: { emoji: "📌", label: "登録済み" },
};

/** 記録の状態を、画面の区分（劇場で見たい／サブスク待ち／視聴済み／見送り）に対応させる。 */
export function stateKeyOf(record: {
  status: Status;
  preferredMedium: PreferredMedium | null;
}): StateKey {
  if (record.status === "WATCHED") return "watched";
  if (record.status === "SKIPPED") return "skipped";
  if (record.status === "WANT_TO_WATCH") {
    if (record.preferredMedium === "THEATER") return "theater";
    if (record.preferredMedium === "STREAMING") return "streaming";
  }
  return "other";
}
