// TMDb の応答の形をまねた、テスト用のデータ。
// 作品はすべて架空のもの。TMDb から取得した実データは、リポジトリに入れない。

export function tmdbMovie(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `映画${id}`,
    original_title: `Movie ${id}`,
    release_date: "2026-01-10",
    poster_path: `/poster-${id}.jpg`,
    backdrop_path: `/backdrop-${id}.jpg`,
    overview: `映画${id}のあらすじ。`,
    adult: false,
    genre_ids: [1, 2],
    popularity: 10,
    ...overrides,
  };
}

export function tmdbList(
  results: unknown[],
  { page = 1, totalPages = 1 }: { page?: number; totalPages?: number } = {},
) {
  return {
    page,
    results,
    total_pages: totalPages,
    total_results: results.length * totalPages,
  };
}

/** /movie/{id} に append_to_response を付けたときの応答（全項目あり）。 */
export function tmdbDetail(id: number, overrides: Record<string, unknown> = {}) {
  return {
    ...tmdbMovie(id),
    runtime: 118,
    genres: [
      { id: 1, name: "ドラマ" },
      { id: 2, name: "ミステリー" },
    ],
    videos: {
      results: [
        { key: "en-trailer", name: "Official Trailer", site: "YouTube", type: "Trailer", official: true, iso_639_1: "en" },
        { key: "ja-teaser", name: "特報", site: "YouTube", type: "Teaser", official: true, iso_639_1: "ja" },
        { key: "ja-fan", name: "予告（非公式）", site: "YouTube", type: "Trailer", official: false, iso_639_1: "ja" },
        { key: "ja-trailer", name: "本予告", site: "YouTube", type: "Trailer", official: true, iso_639_1: "ja" },
        { key: "vimeo-1", name: "Vimeo の予告", site: "Vimeo", type: "Trailer", official: true, iso_639_1: "ja" },
      ],
    },
    credits: {
      cast: [
        { name: "俳優C", order: 2 },
        { name: "俳優A", order: 0 },
        { name: "俳優B", order: 1 },
        { name: "俳優D", order: 3 },
        { name: "俳優E", order: 4 },
        { name: "俳優F", order: 5 },
      ],
      crew: [
        { name: "監督X", job: "Director" },
        { name: "脚本Y", job: "Screenplay" },
      ],
    },
    "watch/providers": {
      results: {
        US: {
          link: "https://www.themoviedb.org/movie/0/watch?locale=US",
          flatrate: [{ provider_id: 900, provider_name: "海外の配信サービス", logo_path: "/us.jpg" }],
        },
        JP: {
          link: `https://www.themoviedb.org/movie/${id}/watch?locale=JP`,
          flatrate: [
            { provider_id: 2, provider_name: "配信サービスB", logo_path: "/b.jpg", display_priority: 5 },
            { provider_id: 1, provider_name: "配信サービスA", logo_path: "/a.jpg", display_priority: 1 },
          ],
          rent: [{ provider_id: 3, provider_name: "レンタルC", logo_path: "/c.jpg", display_priority: 2 }],
          buy: [
            { provider_id: 3, provider_name: "レンタルC", logo_path: "/c.jpg", display_priority: 2 },
            { provider_id: 4, provider_name: "販売D", logo_path: null, display_priority: 9 },
          ],
          ads: [{ provider_id: 5, provider_name: "無料配信E", logo_path: "/e.jpg", display_priority: 3 }],
        },
      },
    },
    ...overrides,
  };
}
