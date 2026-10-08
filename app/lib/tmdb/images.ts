// TMDb の画像サーバーの URL を組み立てる。画像はブラウザが TMDb から直接読み込む。

const IMAGE_BASE = "https://image.tmdb.org/t/p";

export function posterUrl(
  path: string | null | undefined,
  size: "w185" | "w342" | "w500" = "w342",
): string | null {
  return path ? `${IMAGE_BASE}/${size}${path}` : null;
}

export function backdropUrl(
  path: string | null | undefined,
  size: "w780" | "w1280" = "w780",
): string | null {
  return path ? `${IMAGE_BASE}/${size}${path}` : null;
}

export function logoUrl(path: string | null | undefined): string | null {
  return path ? `${IMAGE_BASE}/w92${path}` : null;
}
