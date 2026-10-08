import { useState } from "react";

import { backdropUrl } from "~/lib/tmdb/images";
import type { Trailer } from "~/lib/tmdb/types";

type Props = {
  trailer: Trailer;
  backdropPath: string | null;
  title: string;
  /** テスト用。再生ボタンを押した後の状態で描画する。 */
  defaultPlaying?: boolean;
};

/**
 * 予告動画。再生ボタンを押すまでは YouTube に通信しない（iframe を置かない）。
 * サムネイルには YouTube の画像ではなく、TMDb の背景画像を使う。
 */
export function TrailerPlayer({
  trailer,
  backdropPath,
  title,
  defaultPlaying = false,
}: Props) {
  const [playing, setPlaying] = useState(defaultPlaying);
  const thumbnail = backdropUrl(backdropPath);

  if (playing) {
    return (
      <div className="aspect-video w-full overflow-hidden rounded-xl bg-black">
        <iframe
          src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(trailer.key)}?autoplay=1&rel=0&playsinline=1`}
          title={`${title} の予告動画`}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
          className="h-full w-full border-0"
        />
      </div>
    );
  }

  return (
    // JavaScript が動かない場合は、YouTube のページを別のタブで開くリンクとして働く。
    <a
      href={`https://www.youtube.com/watch?v=${encodeURIComponent(trailer.key)}`}
      target="_blank"
      rel="noreferrer"
      onClick={(event) => {
        event.preventDefault();
        setPlaying(true);
      }}
      aria-label="予告動画を再生する"
      data-trailer="poster"
      className="group relative block aspect-video w-full overflow-hidden rounded-xl bg-zinc-800"
    >
      {thumbnail && (
        <img
          src={thumbnail}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-full w-full object-cover opacity-70 transition-opacity group-hover:opacity-90"
        />
      )}
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-2">
        <span
          aria-hidden="true"
          className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-400 pl-1 text-2xl text-zinc-950 shadow-lg"
        >
          ▶
        </span>
        <span className="rounded bg-black/60 px-2 py-0.5 text-xs">
          予告を見る{trailer.language === "en" ? "（英語）" : ""}
        </span>
      </span>
    </a>
  );
}
