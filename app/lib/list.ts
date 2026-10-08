// リスト画面の絞り込みの種類。画面（ブラウザ側）とサーバー側の両方から使うので、
// サーバー専用のファイル（*.server.ts）には置かない。

export const LIST_FILTERS = ["all", "theater", "streaming", "watched", "skipped"] as const;
export type ListFilter = (typeof LIST_FILTERS)[number];

export const LIST_FILTER_LABELS: Record<ListFilter, string> = {
  all: "すべて",
  theater: "劇場",
  streaming: "サブスク",
  watched: "視聴済み",
  skipped: "見送り",
};

/** トップページの「最近見た」に出す本数。 */
export const RECENT_WATCHED_LIMIT = 5;
