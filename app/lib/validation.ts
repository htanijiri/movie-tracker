import { isValidYmd } from "./date";
import {
  DISCOVERY_TYPES,
  WATCHED_MEDIUMS,
  type DiscoveryType,
  type WatchedMedium,
} from "./db/schema";
import { SELECTABLE_MEDIUMS, type SelectableMedium } from "./labels";

// フォームから送られた値の検証。画面とサーバーの両方から使える（サーバー専用の処理を含めない）。

export const LIMITS = {
  place: 100,
  note: 500,
  review: 5000,
  /** 「気になった予告」の本数の上限（仕様書 013）。 */
  trailerCount: 20,
} as const;

export type FieldErrors = Record<string, string>;
export type Parsed<T> =
  | { ok: true; values: T }
  | { ok: false; errors: FieldErrors; values: Record<string, string> };

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

/** TMDb の映画 ID（正の整数）。不正なら null。 */
export function parseTmdbId(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

/** 「どこまでなら見たいか」。Phase 1 で選べる3つ以外は null。 */
export function parseMedium(form: FormData): SelectableMedium | null {
  const value = text(form, "medium");
  return (SELECTABLE_MEDIUMS as readonly string[]).includes(value)
    ? (value as SelectableMedium)
    : null;
}

export type DiscoveryValues = {
  type: DiscoveryType | null;
  date: string | null;
  place: string | null;
  note: string | null;
};

export function parseDiscovery(form: FormData): Parsed<DiscoveryValues> {
  const raw = {
    type: text(form, "type"),
    date: text(form, "date"),
    place: text(form, "place"),
    note: text(form, "note"),
  };
  const errors: FieldErrors = {};

  if (raw.type !== "" && !(DISCOVERY_TYPES as readonly string[]).includes(raw.type)) {
    errors.type = "きっかけの種類を選び直してください。";
  }
  if (raw.date !== "" && !isValidYmd(raw.date)) {
    errors.date = "日付を正しく入力してください。";
  }
  if (raw.place.length > LIMITS.place) {
    errors.place = `場所は${LIMITS.place}文字以内で入力してください。`;
  }
  if (raw.note.length > LIMITS.note) {
    errors.note = `メモは${LIMITS.note}文字以内で入力してください。`;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, values: raw };
  return {
    ok: true,
    values: {
      type: raw.type === "" ? null : (raw.type as DiscoveryType),
      date: raw.date || null,
      place: raw.place || null,
      note: raw.note || null,
    },
  };
}

export type WatchedValues = {
  watchedAt: string;
  medium: WatchedMedium;
  place: string | null;
  rating: number | null;
  review: string | null;
  /** 劇場で見たときの「気になった予告」の本数（仕様書 013）。劇場以外では常に null。 */
  trailerCount: number | null;
};

export function parseWatched(form: FormData, today: string): Parsed<WatchedValues> {
  const raw = {
    watchedAt: text(form, "watchedAt"),
    medium: text(form, "watchedMedium"),
    place: text(form, "place"),
    rating: text(form, "rating"),
    review: text(form, "review"),
    // 「気になった予告」：なし／1〜3 はラジオボタンの値、「4本以上」（many）は数字の入力欄の値を使う（仕様書 013）。
    trailerChoice: text(form, "trailerChoice"),
    trailerMany: text(form, "trailerMany"),
  };
  const errors: FieldErrors = {};

  if (raw.watchedAt === "" || !isValidYmd(raw.watchedAt)) {
    errors.watchedAt = "見た日を正しく入力してください。";
  } else if (raw.watchedAt > today) {
    errors.watchedAt = "見た日に、今日より後の日付は入力できません。";
  }
  if (!(WATCHED_MEDIUMS as readonly string[]).includes(raw.medium)) {
    errors.watchedMedium = "視聴方法を選んでください。";
  }
  if (raw.place.length > LIMITS.place) {
    errors.place = `場所・サービス名は${LIMITS.place}文字以内で入力してください。`;
  }
  if (raw.rating !== "" && !/^[1-5]$/.test(raw.rating)) {
    errors.rating = "評価は★1〜5で選んでください。";
  }
  if (raw.review.length > LIMITS.review) {
    errors.review = `感想は${LIMITS.review}文字以内で入力してください。`;
  }
  // 「気になった予告」は劇場で見たときだけ使う。劇場以外では、送られてきても無視する。
  let trailerCount: number | null = null;
  if (raw.medium === "THEATER" && raw.trailerChoice !== "") {
    if (/^[0-3]$/.test(raw.trailerChoice)) {
      trailerCount = Number(raw.trailerChoice);
    } else if (
      raw.trailerChoice === "many" &&
      /^\d+$/.test(raw.trailerMany) &&
      Number(raw.trailerMany) >= 4 &&
      Number(raw.trailerMany) <= LIMITS.trailerCount
    ) {
      trailerCount = Number(raw.trailerMany);
    } else {
      errors.trailerCount = `「4本以上」のときは、本数を4〜${LIMITS.trailerCount}で入力してください。`;
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors, values: raw };
  return {
    ok: true,
    values: {
      watchedAt: raw.watchedAt,
      medium: raw.medium as WatchedMedium,
      place: raw.place || null,
      rating: raw.rating === "" ? null : Number(raw.rating),
      review: raw.review || null,
      trailerCount,
    },
  };
}
