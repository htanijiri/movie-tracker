import { Link, useFetcher } from "react-router";

import { formatMonthDay } from "~/lib/date";
import type { StreamingNoticeItem } from "~/lib/streaming.server";

import { Poster } from "./Poster";

/** 配信開始のお知らせ（トップページのいちばん上。仕様書 009）。 */
export function NoticeList({ notices }: { notices: StreamingNoticeItem[] }) {
  if (notices.length === 0) return null;
  return (
    <section aria-labelledby="notices-title" className="mt-4" data-section="notices">
      <h2 id="notices-title" className="section-title mb-2 flex items-center gap-2">
        <span aria-hidden="true">🎉</span>配信が始まりました
      </h2>
      <ul className="space-y-2">
        {notices.map((notice) => (
          <li key={notice.id}>
            <Notice notice={notice} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Notice({ notice }: { notice: StreamingNoticeItem }) {
  const fetcher = useFetcher();
  // 「確認した」を押したら、応答を待たずに消す。
  if (fetcher.formData) return null;
  // 確認した日は、日本時間の日付で出す。
  const detected = formatMonthDay(
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date(notice.detectedAt)),
  );
  return (
    <div
      className="flex items-center gap-3 rounded-xl border border-sky-800 bg-sky-950/40 p-2"
      data-notice={notice.id}
    >
      <Link to={`/movies/${notice.tmdbId}`} className="flex min-w-0 flex-1 items-center gap-3">
        <div className="w-10 shrink-0">
          <Poster path={notice.posterPath} title={notice.title} size="w185" />
        </div>
        <p className="min-w-0 text-sm leading-snug">
          「<span className="font-bold">{notice.title}</span>」が {notice.providerName}{" "}
          で配信を始めました
          <span className="ml-1 text-xs text-muted">{`（${detected}確認）`}</span>
        </p>
      </Link>
      <fetcher.Form method="post" className="shrink-0">
        <input type="hidden" name="intent" value="dismiss-notice" />
        <input type="hidden" name="noticeId" value={notice.id} />
        <button type="submit" className="btn min-h-9 px-3 py-1 text-xs">
          確認した
        </button>
      </fetcher.Form>
    </div>
  );
}
