import { posterUrl } from "~/lib/tmdb/images";

type Props = {
  path: string | null;
  title: string;
  size?: "w185" | "w342" | "w500";
  className?: string;
};

/** 映画のポスター（縦横比 2:3）。画像がない作品では、タイトルを書いた代わりの枠を出す。 */
export function Poster({ path, title, size = "w342", className = "" }: Props) {
  const url = posterUrl(path, size);
  const frame = `aspect-[2/3] w-full overflow-hidden rounded-lg bg-zinc-800 ${className}`;
  if (!url) {
    return (
      <div
        className={`${frame} flex items-center justify-center p-2 text-center text-xs text-zinc-400`}
        data-poster="placeholder"
      >
        {title}
      </div>
    );
  }
  return (
    <div className={frame}>
      <img
        src={url}
        alt={`${title} のポスター`}
        width={342}
        height={513}
        loading="lazy"
        decoding="async"
        className="h-full w-full object-cover"
      />
    </div>
  );
}
