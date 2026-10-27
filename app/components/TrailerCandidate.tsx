import { useState } from "react";
import { Link, useFetcher } from "react-router";

import { formatYmd } from "~/lib/date";
import { MEDIUM_BUTTON_LABELS, SELECTABLE_MEDIUMS, type StateKey } from "~/lib/labels";
import type { Trailer } from "~/lib/tmdb/types";

import { Poster } from "./Poster";
import { StateBadge } from "./StateBadge";
import { TrailerPlayer } from "./TrailerPlayer";

export type CandidateItem = {
  tmdbId: number;
  title: string;
  releaseDate: string | null;
  posterPath: string | null;
  backdropPath?: string | null;
  /** すでにリストにある映画なら、その状態。 */
  state: StateKey | null;
};

type VideoResult = { trailer: Trailer | null; error: string | null };

/**
 * 予告探しの候補1本（仕様書 013）。「予告を見る」でその場で予告を再生し、
 * 「これだった 👍」（登録の区分を選ぶ）か「違う」を押す。
 */
export function TrailerCandidate({ candidate }: { candidate: CandidateItem }) {
  const video = useFetcher<VideoResult>();
  const action = useFetcher();
  const [choosing, setChoosing] = useState(false);

  // 送信したら、応答を待たずに一覧から消す（「これだった」は上の「見つけた予告」に移る）。
  if (action.formData) return null;

  const loadingVideo = video.state !== "idle";
  const trailer = video.data?.trailer ?? null;

  return (
    <div className="rounded-xl border border-zinc-800 p-2" data-candidate={candidate.tmdbId}>
      <div className="flex gap-3">
        <Link to={`/movies/${candidate.tmdbId}`} className="w-16 shrink-0">
          <Poster path={candidate.posterPath} title={candidate.title} size="w185" />
        </Link>
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-bold leading-snug">{candidate.title}</p>
          <p className="mt-0.5 text-xs text-muted">
            {formatYmd(candidate.releaseDate) ? `${formatYmd(candidate.releaseDate)} 公開` : "公開日未定"}
          </p>
          {candidate.state && <StateBadge state={candidate.state} className="mt-1" />}
          <div className="mt-2 flex flex-wrap gap-2">
            {!video.data && (
              <button
                type="button"
                className="btn min-h-9 px-3 py-1 text-xs"
                disabled={loadingVideo}
                onClick={() => video.load(`/trailers/video/${candidate.tmdbId}`)}
              >
                {loadingVideo ? "読み込み中…" : "▶ 予告を見る"}
              </button>
            )}
            {!choosing && (
              <button
                type="button"
                className="btn btn-primary min-h-9 px-3 py-1 text-xs"
                onClick={() =>
                  candidate.state
                    ? // すでにリストにある映画は、区分を選ばずに「これだった」を記録する。
                      action.submit(
                        { intent: "match", candidate: String(candidate.tmdbId) },
                        { method: "post" },
                      )
                    : setChoosing(true)
                }
              >
                これだった 👍
              </button>
            )}
            <action.Form method="post">
              <input type="hidden" name="intent" value="reject" />
              <input type="hidden" name="candidate" value={candidate.tmdbId} />
              <button type="submit" className="btn btn-quiet min-h-9 px-3 py-1 text-xs">
                違う
              </button>
            </action.Form>
          </div>
        </div>
      </div>

      {choosing && (
        <action.Form method="post" className="mt-2" data-choose-medium>
          <input type="hidden" name="intent" value="match" />
          <input type="hidden" name="candidate" value={candidate.tmdbId} />
          <p className="text-xs text-zinc-300">どこまでなら見たい？（リストに登録します）</p>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {SELECTABLE_MEDIUMS.map((medium) => {
              const { emoji, label } = MEDIUM_BUTTON_LABELS[medium];
              return (
                <button
                  key={medium}
                  type="submit"
                  name="medium"
                  value={medium}
                  className="btn min-h-12 flex-col gap-0.5 px-1 text-[11px] leading-tight"
                >
                  <span aria-hidden="true">{emoji}</span>
                  {label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="btn btn-quiet mt-1 w-full text-xs"
            onClick={() => setChoosing(false)}
          >
            やめる
          </button>
        </action.Form>
      )}

      {video.data && (
        <div className="mt-2">
          {trailer ? (
            <TrailerPlayer
              trailer={trailer}
              backdropPath={candidate.backdropPath ?? null}
              title={candidate.title}
              defaultPlaying
            />
          ) : (
            <p className="text-xs text-muted">
              {video.data.error === "tmdb"
                ? "予告を取得できませんでした。時間をおいて試してください"
                : "予告が見つかりませんでした"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
