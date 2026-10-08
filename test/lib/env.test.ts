import { describe, expect, it } from "vitest";

import { getSecret, SECRET_KEYS } from "~/lib/env.server";

describe("設定の読み取り", () => {
  it("テストでは、.dev.vars の実物の値ではなく、固定のダミー値が使われる", () => {
    expect(getSecret("TMDB_ACCESS_TOKEN")).toBe("test-tmdb-token");
    expect(getSecret("ALLOWED_EMAILS")).toBe("owner@example.com");
  });

  it("必要な設定キーがすべて読める", () => {
    for (const key of SECRET_KEYS) {
      expect(getSecret(key)).not.toBe("");
    }
  });
});
