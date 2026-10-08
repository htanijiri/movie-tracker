import { formatYmd } from "./date";
import type { DiscoveryType } from "./db/schema";
import { DISCOVERY_TYPE_LABELS } from "./labels";

/** 上映時間（分）を「1時間58分」の形にする。 */
export function formatRuntime(minutes: number | null | undefined): string {
  if (!minutes || minutes <= 0) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}分`;
  return m === 0 ? `${h}時間` : `${h}時間${m}分`;
}

/** 評価を「★★★☆☆」の形にする。未評価は空文字。 */
export function formatStars(rating: number | null | undefined): string {
  if (!rating || rating < 1 || rating > 5) return "";
  return "★".repeat(rating) + "☆".repeat(5 - rating);
}

type Discovery = {
  discoveryType: DiscoveryType | null;
  discoveryDate: string | null;
  discoveryPlace: string | null;
  discoveryNote: string | null;
};

/** きっかけが1つでも入力されているか。 */
export function hasDiscovery(record: Discovery): boolean {
  return !!(
    record.discoveryType ||
    record.discoveryDate ||
    record.discoveryPlace ||
    record.discoveryNote
  );
}

/**
 * きっかけを1行にする。形は「日付 種類 ・ メモ」。
 * メモがなければ場所を出す。どちらもなければ日付と種類だけ。すべて空なら空文字。
 */
export function formatDiscovery(record: Discovery): string {
  const head = [
    formatYmd(record.discoveryDate),
    record.discoveryType ? DISCOVERY_TYPE_LABELS[record.discoveryType] : "",
  ]
    .filter(Boolean)
    .join(" ");
  const tail = record.discoveryNote || record.discoveryPlace || "";
  return [head, tail].filter(Boolean).join(" ・ ");
}
