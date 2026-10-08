// 日付の扱い。Workers は UTC で動くので、「今日」は必ず日本時間で計算する。
// 日付は `YYYY-MM-DD` の文字列で持ち、時刻を含めない（タイムゾーンのずれを避けるため）。

const TOKYO_YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 日本時間での今日を `YYYY-MM-DD` で返す。 */
export function todayInTokyo(now: Date = new Date()): string {
  return TOKYO_YMD.format(now);
}

/** `YYYY-MM-DD` の形式で、実在する日付かどうか。 */
export function isValidYmd(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
  );
}

/** `YYYY-MM-DD` を `YYYY/MM/DD` にする。不正な値は空文字。 */
export function formatYmd(value: string | null | undefined): string {
  if (!value || !isValidYmd(value)) return "";
  return value.replaceAll("-", "/");
}

/** `YYYY-MM-DD` を `M月D日` にする。不正な値は空文字。 */
export function formatMonthDay(value: string | null | undefined): string {
  if (!value || !isValidYmd(value)) return "";
  const [, m, d] = value.split("-");
  return `${Number(m)}月${Number(d)}日`;
}

/** `YYYY-MM-DD` から年だけを取り出す。不正な値は空文字。 */
export function yearOf(value: string | null | undefined): string {
  if (!value || !isValidYmd(value)) return "";
  return value.slice(0, 4);
}

/** 現在時刻を ISO 8601（UTC）で返す。created_at / updated_at / fetched_at 用。 */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}
