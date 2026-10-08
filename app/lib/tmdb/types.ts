// TMDb から取得した情報を、画面で使う形にしたもの。
// TMDb の応答をそのまま持ち回らず、必要な項目だけに絞る。

export type MovieSummary = {
  tmdbId: number;
  title: string;
  originalTitle: string | null;
  /** 日本での公開日（YYYY-MM-DD）。未定なら null。 */
  releaseDate: string | null;
  posterPath: string | null;
};

export type MovieListPage = {
  page: number;
  totalPages: number;
  results: MovieSummary[];
};

export type Trailer = {
  /** YouTube の動画 ID。 */
  key: string;
  name: string;
  language: string | null;
};

export type Provider = {
  id: number;
  name: string;
  logoPath: string | null;
};

export type WatchProviders = {
  /** TMDb が用意している、配信サービスへのリンク集のページ。 */
  link: string | null;
  /** 定額で見られる。 */
  flatrate: Provider[];
  /** レンタル・購入。 */
  rentOrBuy: Provider[];
  /** 無料（広告付きを含む）。 */
  free: Provider[];
};

export type MovieDetail = MovieSummary & {
  overview: string | null;
  /** 上映時間（分）。 */
  runtime: number | null;
  genres: string[];
  backdropPath: string | null;
  directors: string[];
  cast: string[];
  trailer: Trailer | null;
  /** 日本での配信状況。情報がなければ null。 */
  providers: WatchProviders | null;
};
