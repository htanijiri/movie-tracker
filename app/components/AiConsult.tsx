import { useEffect, useRef } from "react";
import { useFetcher } from "react-router";

import { TrailerCandidate, type CandidateItem } from "./TrailerCandidate";

export type ChatView = {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** AI が挙げた候補（「これだった」「違う」にしたものは除いてある）。 */
  candidates: CandidateItem[];
};

type AskResult = { ok: boolean; error?: string; message?: string };

const PLACEHOLDER = "例：洋画のアクションで、主人公がカーチェイスしていた。最後に「来春公開」と出た気がする";

/**
 * 「AI に相談」（仕様書 014）。覚えていることを送ると、AI が Web 検索で調べて候補を挙げる。
 * 候補は「予告を探す」の候補と同じカードで出す。
 */
export function AiConsult({
  chats,
  configured,
  repliesLeft,
  maxLength,
}: {
  chats: ChatView[];
  configured: boolean;
  repliesLeft: number;
  maxLength: number;
}) {
  const fetcher = useFetcher<AskResult>();
  const formRef = useRef<HTMLFormElement>(null);
  const sending = fetcher.state !== "idle";
  const pending = sending ? String(fetcher.formData?.get("message") ?? "") : "";
  const failed = !sending && fetcher.data && !fetcher.data.ok ? fetcher.data : null;

  // 返答をもらえたら、入力欄を空にする。
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok) formRef.current?.reset();
  }, [fetcher.state, fetcher.data]);

  return (
    <section className="mt-6" aria-labelledby="ai-title" data-section="ai">
      <h2 id="ai-title" className="section-title">
        AI に相談
      </h2>
      <p className="mt-1 text-xs text-muted">
        覚えていることを書いて送ると、AI が Web 検索で調べて候補を挙げます。返答には30秒ほどかかることがあります。
      </p>

      {!configured ? (
        <p className="panel mt-3 text-sm text-zinc-300" data-ai-unconfigured>
          AI の設定がまだです。下の候補一覧は使えます。
        </p>
      ) : (
        <>
          {(chats.length > 0 || pending) && (
            <ol className="mt-3 space-y-3" aria-live="polite">
              {chats.map((chat) => (
                <li key={chat.id} data-chat-role={chat.role}>
                  <ChatBubble role={chat.role} content={chat.content} />
                  {chat.candidates.length > 0 && (
                    <ul className="mt-2 space-y-2">
                      {chat.candidates.map((candidate) => (
                        <li key={candidate.tmdbId}>
                          <TrailerCandidate candidate={candidate} />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
              {pending && (
                <li>
                  <ChatBubble role="user" content={pending} />
                  <p className="mt-2 animate-pulse text-sm text-amber-300" role="status">
                    AI が調べています（30秒ほどかかることがあります）…
                  </p>
                </li>
              )}
            </ol>
          )}

          {failed?.error && (
            <p role="alert" className="panel mt-3 text-sm text-red-300">
              {failed.error}
            </p>
          )}

          <fetcher.Form method="post" ref={formRef} className="mt-3">
            <input type="hidden" name="intent" value="ask" />
            <label htmlFor="ai-message" className="sr-only">
              覚えていること
            </label>
            <textarea
              id="ai-message"
              name="message"
              rows={3}
              required
              maxLength={maxLength}
              placeholder={PLACEHOLDER}
              defaultValue={failed?.message ?? ""}
              key={failed?.message ?? "empty"}
              disabled={sending}
              className="field"
            />
            <div className="mt-2 flex items-center justify-between gap-3">
              <p className="text-xs text-muted" data-replies-left>
                {repliesLeft > 0 ? `今日はあと${repliesLeft}回使えます` : "今日の分は使い切りました"}
              </p>
              <button
                type="submit"
                className="btn btn-primary min-h-10 px-5"
                disabled={sending || repliesLeft <= 0}
              >
                {sending ? "調べています…" : "送る"}
              </button>
            </div>
          </fetcher.Form>
        </>
      )}
    </section>
  );
}

function ChatBubble({ role, content }: { role: "user" | "assistant"; content: string }) {
  return role === "user" ? (
    <div className="ml-8 rounded-2xl rounded-br-sm bg-amber-500/15 px-3 py-2 text-sm whitespace-pre-wrap break-words">
      {content}
    </div>
  ) : (
    <div className="mr-4 rounded-2xl rounded-bl-sm bg-zinc-800 px-3 py-2 text-sm whitespace-pre-wrap break-words">
      <span className="mb-0.5 block text-[11px] font-bold text-amber-300">AI</span>
      {content}
    </div>
  );
}
