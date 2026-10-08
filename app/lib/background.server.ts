import { waitUntil } from "cloudflare:workers";

// 応答を返したあとに続ける処理（画面の表示を待たせたくない後片付けなど）。

const pending = new Set<Promise<void>>();

/** 処理を、応答を返したあとまで続けさせる。失敗しても画面には影響させず、ログにだけ残す。 */
export function runInBackground(task: Promise<unknown>): void {
  const tracked: Promise<void> = task
    .then(() => undefined)
    .catch((error) => console.error("裏で動かした処理が失敗しました:", error))
    .finally(() => pending.delete(tracked));
  pending.add(tracked);
  waitUntil(tracked);
}

/** 動いている処理がすべて終わるのを待つ（テスト用）。 */
export async function settleBackgroundTasks(): Promise<void> {
  while (pending.size > 0) {
    await Promise.all([...pending]);
  }
}
