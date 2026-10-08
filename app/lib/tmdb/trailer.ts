import type { Trailer } from "./types";

type TmdbVideo = {
  key?: string;
  name?: string;
  site?: string;
  type?: string;
  official?: boolean;
  iso_639_1?: string | null;
};

const LANGUAGE_ORDER = ["ja", "en"];

/**
 * 予告動画を1本選ぶ。
 * YouTube の Trailer を、日本語 → 英語 → その他の順に、同じ言語の中では公式のものを優先する。
 * Trailer がなければ Teaser から同じ順で選ぶ。どちらもなければ null。
 */
export function pickTrailer(videos: TmdbVideo[] | undefined): Trailer | null {
  const youtube = (videos ?? []).filter(
    (v) => v.site === "YouTube" && typeof v.key === "string" && v.key !== "",
  );

  const rank = (v: TmdbVideo) => {
    const lang = LANGUAGE_ORDER.indexOf(v.iso_639_1 ?? "");
    return (lang === -1 ? LANGUAGE_ORDER.length : lang) * 2 + (v.official ? 0 : 1);
  };

  for (const type of ["Trailer", "Teaser"]) {
    const candidates = youtube.filter((v) => v.type === type);
    if (candidates.length === 0) continue;
    // sort は安定なので、同じ順位なら TMDb が返した順を保つ。
    const best = [...candidates].sort((a, b) => rank(a) - rank(b))[0];
    return {
      key: best.key!,
      name: best.name ?? "",
      language: best.iso_639_1 ?? null,
    };
  }
  return null;
}
