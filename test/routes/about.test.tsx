import { describe, expect, it } from "vitest";

import { TMDB_NOTICE } from "~/lib/site";
import About from "~/routes/about";

import { renderRoute } from "../helpers/render";

describe("クレジットのページ（/about）", () => {
  const html = renderRoute(About, { path: "/about" });

  it("TMDb の表記の全文が含まれる", () => {
    expect(TMDB_NOTICE).toBe(
      "This product uses the TMDB API but is not endorsed or certified by TMDB.",
    );
    expect(html).toContain(TMDB_NOTICE);
  });

  it("TMDb のロゴが含まれる", () => {
    expect(html).toMatch(/<img[^>]+alt="TMDB"/);
    expect(html).toMatch(/<img[^>]+src="https:\/\/www\.themoviedb\.org\/[^"]+\.svg"/);
  });

  it("配信状況が JustWatch 提供であることが書かれている", () => {
    expect(html).toContain("JustWatch");
  });
});
