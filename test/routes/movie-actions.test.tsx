import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { SessionUser } from "~/context";
import { todayInTokyo } from "~/lib/date";
import { getDb } from "~/lib/db/client.server";
import { listPlaceSuggestions } from "~/lib/db/user-movies.server";
import { formatDiscovery } from "~/lib/format";
import MovieDetailPage, { action, loader } from "~/routes/movie";

import {
  catchThrown,
  createMovie,
  createUser,
  formRequest,
  mockFetch,
  routeArgs,
  statusOf,
} from "../helpers/app";
import { renderRoute } from "../helpers/render";
import { tmdbDetail } from "../helpers/tmdb-fixtures";

type Row = Record<string, string | number | null>;

/** 映画詳細の画面の action を呼ぶ。 */
const post = (user: SessionUser | null, tmdbId: number | string, fields: Record<string, string>) =>
  action(
    routeArgs({
      request: formRequest(`/movies/${tmdbId}`, fields),
      params: { tmdbId: String(tmdbId) },
      user,
    }),
  );

const rowsOf = async (userId?: string): Promise<Row[]> => {
  const stmt = userId
    ? env.DB.prepare("SELECT * FROM user_movies WHERE user_id = ? ORDER BY tmdb_id").bind(userId)
    : env.DB.prepare("SELECT * FROM user_movies ORDER BY tmdb_id");
  return (await stmt.all<Row>()).results;
};

const rowOf = async (userId: string, tmdbId = 1001): Promise<Row | null> =>
  env.DB.prepare("SELECT * FROM user_movies WHERE user_id = ? AND tmdb_id = ?")
    .bind(userId, tmdbId)
    .first<Row>();

/** action の戻り値（成功はそのまま、入力エラーは data() で包まれる）から、中身とステータスを取り出す。 */
function unwrap(result: unknown): { status: number; body: { ok: boolean; errors?: Record<string, string>; values?: Record<string, string> } } {
  const wrapped = result as { type?: string; data?: unknown; init?: ResponseInit | null };
  if (wrapped?.type === "DataWithResponseInit") {
    return { status: wrapped.init?.status ?? 200, body: wrapped.data as never };
  }
  return { status: 200, body: result as never };
}

/** 画面を描画する（loader を呼んでから）。 */
async function renderPage(user: SessionUser, tmdbId = 1001, actionData?: unknown) {
  mockFetch(() => Response.json(tmdbDetail(tmdbId)));
  const loaderData = await loader(
    routeArgs({ params: { tmdbId: String(tmdbId) }, user }),
  );
  return {
    loaderData,
    html: renderRoute(MovieDetailPage, {
      path: "/movies/:tmdbId",
      url: `/movies/${tmdbId}`,
      loaderData,
      actionData,
    }),
  };
}

const pressed = (html: string) =>
  [...html.matchAll(/<button\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes('name="medium"'))
    .map((tag) => ({
      value: /value="([^"]+)"/.exec(tag)![1],
      pressed: tag.includes('aria-pressed="true"'),
    }));

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** HTML の中から、指定した name（と value）を持つ input / button / textarea のタグを取り出す（属性の順番に依存しない）。 */
function tagsNamed(html: string, name: string, value?: string): string[] {
  return [...html.matchAll(/<(?:input|button|textarea)\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => tag.includes(`name="${name}"`))
    .filter((tag) => value === undefined || tag.includes(`value="${value}"`));
}

describe("見たい映画の登録（仕様書 004）", () => {
  it.each([
    ["THEATER", "WANT_TO_WATCH", "THEATER"],
    ["STREAMING", "WANT_TO_WATCH", "STREAMING"],
    ["NONE", "SKIPPED", "NONE"],
  ])("未登録の映画で %s を押すと、行ができる（AC1）", async (medium, status, preferred) => {
    const user = await createUser();
    await createMovie();
    const { status: http, body } = unwrap(await post(user, 1001, { intent: "set-medium", medium }));
    expect(http).toBe(200);
    expect(body.ok).toBe(true);
    expect(await rowOf(user.id)).toMatchObject({
      status,
      preferred_medium: preferred,
      watched_at: null,
      discovery_type: null,
    });
  });

  it("別のボタンを押すと、同じ行の状態だけが変わる。きっかけと作成日時は変わらない（AC2）", async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, { intent: "set-medium", medium: "THEATER" });
    await post(user, 1001, {
      intent: "save-discovery",
      type: "THEATER_TRAILER",
      date: "2026-01-10",
      place: "映画館X",
      note: "「映画A」の上映前",
    });
    const before = (await rowOf(user.id))!;
    await wait(5);

    await post(user, 1001, { intent: "set-medium", medium: "STREAMING" });
    const after = (await rowOf(user.id))!;

    expect(await rowsOf()).toHaveLength(1);
    expect(after).toMatchObject({
      id: before.id,
      status: "WANT_TO_WATCH",
      preferred_medium: "STREAMING",
      discovery_type: "THEATER_TRAILER",
      discovery_date: "2026-01-10",
      discovery_place: "映画館X",
      discovery_note: "「映画A」の上映前",
      created_at: before.created_at,
    });
    expect(after.updated_at! > before.updated_at!).toBe(true);

    await post(user, 1001, { intent: "set-medium", medium: "NONE" });
    expect(await rowOf(user.id)).toMatchObject({ status: "SKIPPED", preferred_medium: "NONE" });
  });

  it("同じ内容を2回送っても、行は1つのまま（AC3）", async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, { intent: "set-medium", medium: "THEATER" });
    await post(user, 1001, { intent: "set-medium", medium: "THEATER" });
    expect(await rowsOf()).toHaveLength(1);
  });

  it("「登録を取り消す」は、その利用者のその映画の行だけを消す（AC4）", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    await createMovie({ tmdbId: 1001 });
    await createMovie({ tmdbId: 1002 });
    await post(me, 1001, { intent: "set-medium", medium: "THEATER" });
    await post(me, 1002, { intent: "set-medium", medium: "THEATER" });
    await post(other, 1001, { intent: "set-medium", medium: "STREAMING" });

    expect(unwrap(await post(me, 1001, { intent: "remove" })).body.ok).toBe(true);

    expect((await rowsOf(me.id)).map((r) => r.tmdb_id)).toEqual([1002]);
    expect((await rowsOf(other.id)).map((r) => r.tmdb_id)).toEqual([1001]);
  });

  it("視聴済みの映画でボタンの POST を送っても、見た記録は消えず、視聴済みのまま（AC5）", async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, { intent: "set-medium", medium: "THEATER" });
    await post(user, 1001, {
      intent: "save-watched",
      watchedAt: "2026-01-10",
      watchedMedium: "THEATER",
      place: "映画館X",
      rating: "4",
      review: "よかった",
    });

    await post(user, 1001, { intent: "set-medium", medium: "NONE" });

    expect(await rowOf(user.id)).toMatchObject({
      status: "WATCHED",
      preferred_medium: "NONE",
      watched_at: "2026-01-10",
      watched_medium: "THEATER",
      watched_place: "映画館X",
      rating: 4,
      review: "よかった",
    });
  });

  it.each(["RENTAL", "ANY", "INVALID", ""])(
    "3種類以外の値（%s）は 400 で、DB は変わらない（AC6）",
    async (medium) => {
      const user = await createUser();
      await createMovie();
      const { status, body } = unwrap(await post(user, 1001, { intent: "set-medium", medium }));
      expect(status).toBe(400);
      expect(body.ok).toBe(false);
      expect(await rowsOf()).toHaveLength(0);
    },
  );

  it("登録時にスナップショットがなければ、TMDb から取得して作る（AC7）", async () => {
    const user = await createUser();
    const fetchMock = mockFetch(() => Response.json(tmdbDetail(77, { title: "映画77" })));
    await post(user, 77, { intent: "set-medium", medium: "THEATER" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT title FROM movies WHERE tmdb_id = 77").first()).toEqual({
      title: "映画77",
    });
    expect(await rowOf(user.id, 77)).toMatchObject({ status: "WANT_TO_WATCH" });
  });

  it("スナップショットがすでにあれば、登録のときに TMDb を呼ばない", async () => {
    const user = await createUser();
    await createMovie();
    const fetchMock = mockFetch(() => Response.json(tmdbDetail(1001)));
    await post(user, 1001, { intent: "set-medium", medium: "THEATER" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("TMDb にない映画は登録できない（404）", async () => {
    const user = await createUser();
    mockFetch(() => Response.json({ status_code: 34 }, { status: 404 }));
    const thrown = await catchThrown(() => post(user, 424242, { intent: "set-medium", medium: "THEATER" }));
    expect(statusOf(thrown)).toBe(404);
    expect(await rowsOf()).toHaveLength(0);
  });

  it("選択中のボタンにだけ aria-pressed=true が付く。未登録ではどれにも付かない（AC8）", async () => {
    const user = await createUser();
    await createMovie();
    expect(pressed((await renderPage(user)).html)).toEqual([
      { value: "THEATER", pressed: false },
      { value: "STREAMING", pressed: false },
      { value: "NONE", pressed: false },
    ]);

    await post(user, 1001, { intent: "set-medium", medium: "STREAMING" });
    expect(pressed((await renderPage(user)).html)).toEqual([
      { value: "THEATER", pressed: false },
      { value: "STREAMING", pressed: true },
      { value: "NONE", pressed: false },
    ]);
  });

  it("ボタンは通常のフォームの POST として送れる（JavaScript が無効でも登録できる）（AC9）", async () => {
    const user = await createUser();
    await createMovie();
    const { html } = await renderPage(user);
    // intent を持つ POST のフォームの中に、name と value を持つ送信ボタンがある。
    expect(html).toMatch(
      /<form[^>]*method="post"[^>]*>\s*<input type="hidden" name="intent" value="set-medium"\/>/,
    );
    const button = tagsNamed(html, "medium", "THEATER")[0];
    expect(button).toContain("<button");
    expect(button).toContain('type="submit"');
  });

  it("不明な intent は 400", async () => {
    const user = await createUser();
    await createMovie();
    expect(unwrap(await post(user, 1001, { intent: "drop-table" })).status).toBe(400);
  });

  it("未ログインでは 401 で、何も保存しない", async () => {
    await createMovie();
    const thrown = await catchThrown(() => post(null, 1001, { intent: "set-medium", medium: "THEATER" }));
    expect(statusOf(thrown)).toBe(401);
    expect(await rowsOf()).toHaveLength(0);
  });
});

describe("知ったきっかけ（仕様書 005）", () => {
  const registered = async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, { intent: "set-medium", medium: "THEATER" });
    return user;
  };

  it("種類・日付・場所・メモを保存する。状態は変わらない（AC1）", async () => {
    const user = await registered();
    const { status, body } = unwrap(
      await post(user, 1001, {
        intent: "save-discovery",
        type: "THEATER_TRAILER",
        date: "2026-01-10",
        place: " 映画館X ",
        note: "「映画A」の上映前",
      }),
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(await rowOf(user.id)).toMatchObject({
      status: "WANT_TO_WATCH",
      preferred_medium: "THEATER",
      discovery_type: "THEATER_TRAILER",
      discovery_date: "2026-01-10",
      discovery_place: "映画館X",
      discovery_note: "「映画A」の上映前",
    });
  });

  it.each(["THEATER_TRAILER", "TV_CM", "WEB_CM", "SNS", "ARTICLE", "FRIEND", "OTHER"])(
    "種類 %s を受け付ける（AC2）",
    async (type) => {
      const user = await registered();
      expect(unwrap(await post(user, 1001, { intent: "save-discovery", type })).status).toBe(200);
      expect((await rowOf(user.id))!.discovery_type).toBe(type);
    },
  );

  it("定義にない種類は 400（AC2）", async () => {
    const user = await registered();
    const { status, body } = unwrap(await post(user, 1001, { intent: "save-discovery", type: "RADIO" }));
    expect(status).toBe(400);
    expect(body.errors).toHaveProperty("type");
    expect((await rowOf(user.id))!.discovery_type).toBeNull();
  });

  it.each([
    ["実在しない日付", { date: "2026-02-30" }, "date"],
    ["形式の違う日付", { date: "2026/01/10" }, "date"],
    ["101文字の場所", { place: "あ".repeat(101) }, "place"],
    ["501文字のメモ", { note: "あ".repeat(501) }, "note"],
  ])("%s は 400 で、入力内容を保ったままエラーを返す（AC3）", async (_label, fields, key) => {
    const user = await registered();
    const sent = { intent: "save-discovery", type: "SNS", ...fields };
    const { status, body } = unwrap(await post(user, 1001, sent));
    expect(status).toBe(400);
    expect(body.errors).toHaveProperty(key);
    expect(body.values).toMatchObject(fields);
    expect((await rowOf(user.id))!.discovery_type).toBeNull();

    // エラーと、入力した内容が、画面に表示される。
    const { html } = await renderPage(user, 1001, { ...body, intent: "save-discovery" });
    expect(html).toContain('role="alert"');
    expect(html).toContain(body.errors![key]);
  });

  it("上限ちょうどの長さ（場所100文字、メモ500文字）は保存できる。空の日付は NULL になる（AC3）", async () => {
    const user = await registered();
    const { status } = unwrap(
      await post(user, 1001, {
        intent: "save-discovery",
        type: "SNS",
        date: "",
        place: "あ".repeat(100),
        note: "い".repeat(500),
      }),
    );
    expect(status).toBe(200);
    expect(await rowOf(user.id)).toMatchObject({ discovery_type: "SNS", discovery_date: null });
  });

  it("すべて空にして保存すると、きっかけが消える（AC4）", async () => {
    const user = await registered();
    await post(user, 1001, { intent: "save-discovery", type: "SNS", date: "2026-01-10", place: "X", note: "Y" });
    await post(user, 1001, { intent: "save-discovery", type: "", date: "", place: "", note: "" });
    expect(await rowOf(user.id)).toMatchObject({
      discovery_type: null,
      discovery_date: null,
      discovery_place: null,
      discovery_note: null,
      status: "WANT_TO_WATCH",
    });
  });

  it("未登録の映画には保存できない（400）（AC5）", async () => {
    const user = await createUser();
    await createMovie();
    const { status } = unwrap(await post(user, 1001, { intent: "save-discovery", type: "SNS" }));
    expect(status).toBe(400);
    expect(await rowsOf()).toHaveLength(0);
  });

  it("他の利用者の記録には保存されない", async () => {
    const me = await registered();
    const other = await createUser({ email: "other@example.com" });
    const { status } = unwrap(await post(other, 1001, { intent: "save-discovery", type: "SNS" }));
    expect(status).toBe(400);
    expect((await rowOf(me.id))!.discovery_type).toBeNull();
  });

  it("場所の候補は、きっかけの場所と劇場で見た場所を、重複なし・新しい順・最大10件で返す。他の利用者の入力は含まない（AC6）", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    for (let i = 1; i <= 13; i++) {
      await createMovie({ tmdbId: i });
      await post(me, i, { intent: "set-medium", medium: "THEATER" });
      await post(me, i, { intent: "save-discovery", type: "THEATER_TRAILER", place: `映画館${i <= 2 ? 1 : i}` });
      await wait(2);
    }
    // 劇場で見た場所と、配信で見たサービス名。
    await post(me, 1, { intent: "save-watched", watchedAt: "2026-01-10", watchedMedium: "THEATER", place: "劇場Z" });
    await wait(2);
    await post(me, 2, { intent: "save-watched", watchedAt: "2026-01-10", watchedMedium: "STREAMING", place: "配信サービスA" });
    await post(other, 3, { intent: "set-medium", medium: "THEATER" });
    await post(other, 3, { intent: "save-discovery", type: "SNS", place: "他人の映画館" });

    const { discovery } = await listPlaceSuggestions(getDb(), me.id);
    expect(discovery).toHaveLength(10);
    expect(new Set(discovery).size).toBe(10);
    // 最後に更新した行のものが先頭。配信サービスの名前は、場所の候補に出さない。
    expect(discovery.slice(0, 3)).toEqual(["映画館1", "劇場Z", "映画館13"]);
    expect(discovery).not.toContain("配信サービスA");
    expect(discovery).not.toContain("他人の映画館");
  });

  it("1行表示は「日付 種類 ・ メモ」。メモがなければ場所、どちらもなければ日付と種類だけ。すべて空なら空文字（AC7）", () => {
    const base = { discoveryType: null, discoveryDate: null, discoveryPlace: null, discoveryNote: null };
    expect(
      formatDiscovery({
        discoveryType: "THEATER_TRAILER",
        discoveryDate: "2026-01-10",
        discoveryPlace: "映画館X",
        discoveryNote: "「映画A」の上映前",
      }),
    ).toBe("2026/01/10 映画館の予告 ・ 「映画A」の上映前");
    expect(
      formatDiscovery({ ...base, discoveryType: "THEATER_TRAILER", discoveryDate: "2026-01-10", discoveryPlace: "映画館X" }),
    ).toBe("2026/01/10 映画館の予告 ・ 映画館X");
    expect(formatDiscovery({ ...base, discoveryType: "SNS", discoveryDate: "2026-01-10" })).toBe("2026/01/10 SNS");
    expect(formatDiscovery({ ...base, discoveryType: "FRIEND" })).toBe("人から聞いた");
    expect(formatDiscovery({ ...base, discoveryNote: "メモだけ" })).toBe("メモだけ");
    expect(formatDiscovery(base)).toBe("");
  });

  it("メモに入れた <script> は、タグとして出力されない（AC8）", async () => {
    const user = await registered();
    await post(user, 1001, { intent: "save-discovery", type: "SNS", note: "<script>alert(1)</script>" });
    const { html } = await renderPage(user);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("未入力のときは「きっかけを書く」と今日の日付、入力済みのときは1行表示と「きっかけを編集」を出す", async () => {
    const user = await registered();
    const before = (await renderPage(user)).html;
    expect(before).toContain("きっかけを書く");
    expect(tagsNamed(before, "date", todayInTokyo())).toHaveLength(1);

    await post(user, 1001, { intent: "save-discovery", type: "SNS", date: "2026-01-10" });
    const after = (await renderPage(user)).html;
    expect(after).toContain("2026/01/10 SNS");
    expect(after).toContain("きっかけを編集");
    expect(tagsNamed(after, "date", "2026-01-10")).toHaveLength(1);
    expect(tagsNamed(after, "type", "SNS")[0]).toContain('checked=""');
  });

  it("未登録の映画の画面には、きっかけの欄を出さない", async () => {
    const user = await createUser();
    await createMovie();
    expect((await renderPage(user)).html).not.toContain("data-discovery");
  });
});

describe("視聴済みの記録（仕様書 006）", () => {
  const today = todayInTokyo();
  const watchedFields = (extra: Record<string, string> = {}) => ({
    intent: "save-watched",
    watchedAt: "2026-01-10",
    watchedMedium: "THEATER",
    ...extra,
  });

  it("見た日と視聴方法を保存すると視聴済みになる。見たい区分ときっかけは変わらない（AC1）", async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, { intent: "set-medium", medium: "STREAMING" });
    await post(user, 1001, { intent: "save-discovery", type: "SNS", date: "2026-01-05" });

    const { status, body } = unwrap(
      await post(user, 1001, watchedFields({ watchedMedium: "STREAMING", place: "配信サービスA", rating: "5", review: "最高\n2行目" })),
    );
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(await rowOf(user.id)).toMatchObject({
      status: "WATCHED",
      preferred_medium: "STREAMING",
      discovery_type: "SNS",
      discovery_date: "2026-01-05",
      watched_at: "2026-01-10",
      watched_medium: "STREAMING",
      watched_place: "配信サービスA",
      rating: 5,
      review: "最高\n2行目",
    });
  });

  it("未登録の映画に直接「見た」を付けると、視聴済みの行とスナップショットができる（AC2）", async () => {
    const user = await createUser();
    mockFetch(() => Response.json(tmdbDetail(77)));
    await post(user, 77, watchedFields());
    expect(await rowOf(user.id, 77)).toMatchObject({
      status: "WATCHED",
      preferred_medium: null,
      watched_at: "2026-01-10",
      watched_medium: "THEATER",
      watched_place: null,
      rating: null,
      review: null,
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM movies WHERE tmdb_id = 77").first()).toEqual({ n: 1 });
  });

  it.each([
    ["見た日が空", { watchedAt: "" }, "watchedAt"],
    ["実在しない日付", { watchedAt: "2026-02-30" }, "watchedAt"],
    ["今日より後の日付", { watchedAt: "2999-01-01" }, "watchedAt"],
    ["視聴方法が空", { watchedMedium: "" }, "watchedMedium"],
    ["定義にない視聴方法", { watchedMedium: "ANY" }, "watchedMedium"],
  ])("%s は 400（AC3）", async (_label, fields, key) => {
    const user = await createUser();
    await createMovie();
    const { status, body } = unwrap(await post(user, 1001, watchedFields(fields)));
    expect(status).toBe(400);
    expect(body.errors).toHaveProperty(key);
    expect(await rowsOf()).toHaveLength(0);
  });

  it("今日の日付と、4つの視聴方法は受け付ける（AC3）", async () => {
    const user = await createUser();
    await createMovie();
    for (const medium of ["THEATER", "STREAMING", "RENTAL", "OTHER"]) {
      const { status } = unwrap(await post(user, 1001, watchedFields({ watchedAt: today, watchedMedium: medium })));
      expect(status).toBe(200);
      expect(await rowOf(user.id)).toMatchObject({ watched_at: today, watched_medium: medium });
    }
  });

  it.each([
    ["評価 0", { rating: "0" }, "rating"],
    ["評価 6", { rating: "6" }, "rating"],
    ["評価が整数でない", { rating: "3.5" }, "rating"],
    ["101文字の場所", { place: "あ".repeat(101) }, "place"],
    ["5001文字の感想", { review: "あ".repeat(5001) }, "review"],
  ])("%s は 400 で、入力内容を保ったままエラーを表示する（AC4）", async (_label, fields, key) => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, { intent: "set-medium", medium: "THEATER" });
    const { status, body } = unwrap(await post(user, 1001, watchedFields({ review: "途中まで書いた感想", ...fields })));
    expect(status).toBe(400);
    expect(body.errors).toHaveProperty(key);
    expect((await rowOf(user.id))!.status).toBe("WANT_TO_WATCH");

    const { html } = await renderPage(user, 1001, { ...body, intent: "save-watched" });
    expect(html).toContain(body.errors![key]);
    if (key !== "review") expect(html).toContain("途中まで書いた感想");
    // エラーがあるときは、入力欄を開いた状態で表示する。
    expect(html).toMatch(/<details[^>]*open=""[^>]*>\s*<summary[^>]*>.*?見た/s);
  });

  it("評価は空（なし）と 1〜5、感想は5000文字まで保存できる（AC4）", async () => {
    const user = await createUser();
    await createMovie();
    for (const rating of ["", "1", "5"]) {
      expect(unwrap(await post(user, 1001, watchedFields({ rating, review: "あ".repeat(5000) }))).status).toBe(200);
      expect((await rowOf(user.id))!.rating).toBe(rating === "" ? null : Number(rating));
    }
  });

  it("すでに視聴済みの映画に保存し直すと、同じ行が上書きされる（AC5）", async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, watchedFields({ rating: "3", review: "初回" }));
    const first = (await rowOf(user.id))!;
    await post(user, 1001, watchedFields({ watchedAt: "2026-01-11", rating: "4", review: "書き直し" }));

    expect(await rowsOf()).toHaveLength(1);
    expect(await rowOf(user.id)).toMatchObject({
      id: first.id,
      watched_at: "2026-01-11",
      rating: 4,
      review: "書き直し",
      created_at: first.created_at,
    });
  });

  it.each([
    ["THEATER", "WANT_TO_WATCH"],
    ["STREAMING", "WANT_TO_WATCH"],
    ["NONE", "SKIPPED"],
  ])("見た記録を取り消すと、見る前の状態（%s → %s）に戻る（AC6）", async (medium, status) => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, { intent: "set-medium", medium });
    await post(user, 1001, { intent: "save-discovery", type: "SNS" });
    await post(user, 1001, watchedFields({ place: "映画館X", rating: "4", review: "感想" }));

    expect(unwrap(await post(user, 1001, { intent: "unwatch" })).body.ok).toBe(true);

    expect(await rowOf(user.id)).toMatchObject({
      status,
      preferred_medium: medium,
      discovery_type: "SNS",
      watched_at: null,
      watched_medium: null,
      watched_place: null,
      rating: null,
      review: null,
    });
  });

  it("直接「見た」を付けた映画の見た記録を取り消すと、行ごと消える（AC6）", async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, watchedFields());
    await post(user, 1001, { intent: "unwatch" });
    expect(await rowsOf()).toHaveLength(0);
  });

  it("視聴済みでない映画に取り消しを送っても、何も変わらない", async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, { intent: "set-medium", medium: "THEATER" });
    await post(user, 1001, { intent: "unwatch" });
    expect(await rowOf(user.id)).toMatchObject({ status: "WANT_TO_WATCH", preferred_medium: "THEATER" });
  });

  it("他の利用者の見た記録は取り消せない", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    await createMovie();
    await post(me, 1001, watchedFields());
    await post(other, 1001, { intent: "unwatch" });
    expect((await rowOf(me.id))!.status).toBe("WATCHED");
  });

  it.each([
    ["THEATER", "THEATER"],
    ["STREAMING", "STREAMING"],
    ["NONE", null],
    [null, null],
  ])("フォームの初期値：見たい区分が %s なら、視聴方法は %s が選ばれている。見た日は今日（AC7）", async (medium, expected) => {
    const user = await createUser();
    await createMovie();
    if (medium) await post(user, 1001, { intent: "set-medium", medium });

    const { loaderData, html } = await renderPage(user);
    expect(loaderData.today).toBe(today);
    const dateInput = tagsNamed(html, "watchedAt")[0];
    expect(dateInput).toContain(`value="${today}"`);
    expect(dateInput).toContain(`max="${today}"`);

    const checked = tagsNamed(html, "watchedMedium")
      .filter((tag) => tag.includes('checked=""'))
      .map((tag) => /value="([^"]+)"/.exec(tag)![1]);
    expect(checked).toEqual(expected ? [expected] : []);
  });

  it("場所・サービス名の候補は、視聴方法ごとに分かれる。劇場にはきっかけの場所も含む。他の利用者の入力は含まない（AC8）", async () => {
    const me = await createUser();
    const other = await createUser({ email: "other@example.com" });
    for (const id of [1, 2, 3, 4]) await createMovie({ tmdbId: id });
    await post(me, 1, watchedFields({ watchedMedium: "THEATER", place: "映画館X" }));
    await wait(2);
    await post(me, 2, watchedFields({ watchedMedium: "STREAMING", place: "配信サービスA" }));
    await wait(2);
    await post(me, 3, watchedFields({ watchedMedium: "STREAMING", place: "配信サービスA" }));
    await wait(2);
    await post(me, 4, { intent: "set-medium", medium: "THEATER" });
    await post(me, 4, { intent: "save-discovery", type: "THEATER_TRAILER", place: "映画館Y" });
    await post(other, 1, watchedFields({ watchedMedium: "STREAMING", place: "他人のサービス" }));

    const { watched } = await listPlaceSuggestions(getDb(), me.id);
    expect(watched.THEATER).toEqual(["映画館Y", "映画館X"]);
    expect(watched.STREAMING).toEqual(["配信サービスA"]);
    expect(watched.RENTAL).toEqual([]);
    expect(watched.OTHER).toEqual([]);

    // 画面では、選択中の視聴方法の候補だけが出る（この映画は「劇場で見たい」なので劇場）。
    const { html } = await renderPage(me, 4);
    const datalist = /<datalist id="watched-place-options">(.*?)<\/datalist>/s.exec(html)![1];
    expect(datalist).toContain('value="映画館X"');
    expect(datalist).not.toContain("配信サービスA");
  });

  it("感想の改行はそのまま表示され、HTML タグはエスケープされる（AC9）", async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, watchedFields({ review: "1行目\n<b>太字</b>\n3行目" }));
    const { html } = await renderPage(user);
    const review = /<p[^>]*data-review[^>]*>(.*?)<\/p>/s.exec(html)!;
    expect(review[0]).toContain("whitespace-pre-wrap");
    expect(review[1]).toBe("1行目\n&lt;b&gt;太字&lt;/b&gt;\n3行目");
  });

  it("視聴済みの画面では、3つのボタンの代わりに、見た記録と「編集」「取り消す」を表示する（AC10）", async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, { intent: "set-medium", medium: "THEATER" });
    await post(user, 1001, watchedFields({ place: "映画館X", rating: "4", review: "感想" }));

    const { html } = await renderPage(user);
    expect(html).toContain('data-watched="summary"');
    expect(html).toContain("2026/01/10");
    expect(html).toContain("劇場（映画館X）");
    expect(html).toContain("★★★★☆");
    expect(html).toContain("感想");
    expect(html).toContain("見た記録を編集");
    expect(html).toContain("見た記録を取り消す");
    expect(html).toContain("「見たい」に登録していたときの状態に戻ります");
    expect(pressed(html)).toEqual([]);
    expect(html).not.toContain("登録を取り消す");
    // 編集のフォームには、保存済みの内容が入っている。
    expect(tagsNamed(html, "watchedAt", "2026-01-10")).toHaveLength(1);
    expect(tagsNamed(html, "place", "映画館X")).toHaveLength(1);
    expect(tagsNamed(html, "rating", "4")[0]).toContain('checked=""');
  });

  it("直接「見た」を付けた映画では、取り消すとリストから消えることを伝える", async () => {
    const user = await createUser();
    await createMovie();
    await post(user, 1001, watchedFields());
    expect((await renderPage(user)).html).toContain("この映画はリストから消えます");
  });
});
