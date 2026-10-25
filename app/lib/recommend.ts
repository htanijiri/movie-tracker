// おすすめ（仕様書 012）の切り替えと絞り込みの種類。画面とサーバーの両方から使うので、
// サーバー専用のファイル（*.server.ts）には置かない。

export const RECOMMEND_SOURCES = ["theater", "streaming"] as const;
export type RecommendSource = (typeof RECOMMEND_SOURCES)[number];
export const RECOMMEND_LANGS = ["all", "ja", "foreign"] as const;
export type RecommendLang = (typeof RECOMMEND_LANGS)[number];
