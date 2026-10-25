import { isValidYmd } from "./date";

// 「劇場で見たい」の映画に出す、公開日についての表示（仕様書 010・011）。
// 画面とサーバーの両方で使う。日付は YYYY-MM-DD の文字列を UTC の日付として扱い、時刻を持ち込まない。

/** 公開からこの日数を過ぎたら「そろそろ上映終了かも」と出す（仕様書 010）。 */
export const ENDING_SOON_DAYS = 28;

export type ReleaseStatus = {
  kind: "upcoming" | "showing" | "unknown";
  label: string;
  /** 「そろそろ上映終了かも」のとき true。 */
  warning: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function toUtc(ymd: string): Date {
  return new Date(`${ymd}T00:00:00Z`);
}

/** from から to までの日数（to が後なら正）。 */
export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / DAY_MS);
}

/** その日を含む週の月曜日（UTC のミリ秒）。 */
function weekStart(date: Date): number {
  const offset = (date.getUTCDay() + 6) % 7; // 月曜=0 … 日曜=6
  return date.getTime() - offset * DAY_MS;
}

function monthIndex(date: Date): number {
  return date.getUTCFullYear() * 12 + date.getUTCMonth();
}

/**
 * 公開日と今日から、表示する文言を決める。
 * - 公開前：今日公開 → 明日公開 → 今週公開 → 来週公開 → 今月公開 → 来月公開 → 「M月D日公開」の順に当てはめる（週は月曜始まり）
 * - 公開後：「公開◯週目」（公開日から6日目までが1週目）。28日を過ぎたら「・そろそろ上映終了かも」を付ける
 * - 公開日が分からない：「公開日未定」
 */
export function releaseStatus(
  releaseDate: string | null | undefined,
  today: string,
): ReleaseStatus {
  if (!releaseDate || !isValidYmd(releaseDate) || !isValidYmd(today)) {
    return { kind: "unknown", label: "公開日未定", warning: false };
  }

  const days = daysBetween(today, releaseDate); // 公開日まであと何日か（過ぎていれば負）
  if (days === 0) return { kind: "showing", label: "今日公開", warning: false };

  if (days < 0) {
    const elapsed = -days;
    const week = Math.floor(elapsed / 7) + 1;
    const warning = elapsed >= ENDING_SOON_DAYS;
    return {
      kind: "showing",
      label: warning ? `公開${week}週目・そろそろ上映終了かも` : `公開${week}週目`,
      warning,
    };
  }

  const release = toUtc(releaseDate);
  const now = toUtc(today);
  const md = `${release.getUTCMonth() + 1}/${release.getUTCDate()}`;
  const upcoming = (label: string): ReleaseStatus => ({ kind: "upcoming", label, warning: false });

  if (days === 1) return upcoming("明日公開");
  const weekDiff = Math.round((weekStart(release) - weekStart(now)) / (7 * DAY_MS));
  if (weekDiff === 0) return upcoming(`今週公開（${md}）`);
  if (weekDiff === 1) return upcoming(`来週公開（${md}）`);
  const monthDiff = monthIndex(release) - monthIndex(now);
  if (monthDiff === 0) return upcoming(`今月公開（${md}）`);
  if (monthDiff === 1) return upcoming(`来月公開（${md}）`);
  if (release.getUTCFullYear() === now.getUTCFullYear()) {
    return upcoming(`${release.getUTCMonth() + 1}月${release.getUTCDate()}日公開`);
  }
  return upcoming(
    `${release.getUTCFullYear()}年${release.getUTCMonth() + 1}月${release.getUTCDate()}日公開`,
  );
}
