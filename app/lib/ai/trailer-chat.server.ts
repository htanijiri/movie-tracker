import Anthropic from "@anthropic-ai/sdk";

import { getSecret, hasSecret } from "~/lib/env.server";

// 「AI に相談」（仕様書 014）。覚えていることをもとに、AI（Claude）が Web 検索で予告の作品を絞り込む。
// AI に送るのは、見た映画のタイトルと見た日・その時期の候補・「違う」にした作品・会話の本文だけ。
// 映画館の名前、★や感想、メールアドレスは送らない（呼び出す側で渡さない）。

export const AI_MODEL = "claude-sonnet-5-5";
/** 返答1回あたりの Web 検索の上限（費用を抑えるため）。 */
const MAX_SEARCHES = 5;
/** 検索が長引いて `pause_turn` で止まったときに、続きを頼む回数の上限。 */
const MAX_CONTINUATIONS = 2;
/** 1回の API 呼び出しの待ち時間の上限（ミリ秒）。検索を含むので長めにする。 */
const TIMEOUT_MS = 120_000;
/** AI が1回に挙げる候補の上限。 */
export const MAX_AI_CANDIDATES = 5;

export class TrailerAiError extends Error {
  constructor(
    message: string,
    readonly reason: "refusal" | "failed",
  ) {
    super(message);
    this.name = "TrailerAiError";
  }
}

export type AiContext = {
  visitTitle: string;
  visitDate: string;
  /** その時期に公開される映画の候補（TMDb）。 */
  candidates: { tmdbId: number; title: string; originalTitle: string | null; releaseDate: string | null }[];
  /** 「違う」にした作品のタイトル。 */
  rejectedTitles: string[];
  /** それまでの会話（本文だけ。古い順）。 */
  history: { role: "user" | "assistant"; content: string }[];
  /** 今回の入力。 */
  message: string;
};

export type AiSuggestion = {
  /** 候補の一覧にある作品なら、その TMDb の ID。一覧にない作品は null。 */
  tmdbId: number | null;
  title: string;
  originalTitle: string | null;
  year: number | null;
  reason: string;
};

export type AiReply = { message: string; suggestions: AiSuggestion[] };

export function isTrailerAiConfigured(): boolean {
  return hasSecret("ANTHROPIC_API_KEY");
}

const SYSTEM_PROMPT = `あなたは、映画館で本編の上映前に流れた予告編のうち、利用者が「気になった」作品を特定する手伝いをします。

- 利用者は、予告で見た内容をうろ覚えで書きます。ジャンル、邦画か洋画か、アニメか実写か、出演者、場面、音楽、画面に出た公開時期などの手がかりを整理してください。
- 必要に応じて Web 検索で調べてください（日本での公開予定、予告編の公開情報、映画のニュース記事など）。予告で見た作品は、見た日の時点で公開前か公開直後のことが多いです。
- 候補を挙げるときは、「その時期に公開される映画の候補」にある作品を優先し、その tmdb_id を使ってください。一覧にない作品を挙げるときは tmdb_id を 0 にし、日本での題名（邦題）と原題、日本での公開年を入れてください。分からない項目は、原題は空文字、公開年は 0 にします。
- 「違う」とされた作品と、見た映画そのものは、候補にしないでください。
- 手がかりが足りず絞り込めないときは、候補を無理に挙げず、思い出せそうな点を1〜2個だけ質問してください。
- 返答は、必ず最後に show_candidates ツールを1回呼んで終えてください。message には利用者への返答を、日本語で短く（3〜6文程度）、Markdown を使わずに書きます。candidates には候補を最大${MAX_AI_CANDIDATES}件、可能性の高い順に入れ、reason にはその作品だと考えた理由を一言で書きます。候補がないときは空の配列にします。`;

const SHOW_CANDIDATES_TOOL = {
  name: "show_candidates",
  description:
    "利用者への返答と、予告の作品の候補を画面に表示する。返答の最後に必ず1回だけ呼ぶ。",
  strict: true,
  input_schema: {
    type: "object" as const,
    properties: {
      message: { type: "string", description: "利用者への返答（日本語、Markdown なし）" },
      candidates: {
        type: "array",
        description: `予告の作品の候補（最大${MAX_AI_CANDIDATES}件、可能性の高い順）`,
        items: {
          type: "object",
          properties: {
            tmdb_id: { type: "integer", description: "候補の一覧にある作品の tmdb_id。一覧にない作品は 0" },
            title: { type: "string", description: "日本での題名" },
            original_title: { type: "string", description: "原題。分からなければ空文字" },
            year: { type: "integer", description: "日本での公開年。分からなければ 0" },
            reason: { type: "string", description: "その作品だと考えた理由（一言）" },
          },
          required: ["tmdb_id", "title", "original_title", "year", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["message", "candidates"],
    additionalProperties: false,
  },
};

const WEB_SEARCH_TOOL = {
  type: "web_search_20260209" as const,
  name: "web_search" as const,
  max_uses: MAX_SEARCHES,
  user_location: { type: "approximate" as const, country: "JP", timezone: "Asia/Tokyo" },
};

/** 予告探しごとに変わらない部分（見た映画と候補の一覧）。プロンプトキャッシュが効くよう、システムプロンプトに置く。 */
function huntContext(context: AiContext): string {
  const lines = context.candidates.map(
    (c) => `${c.tmdbId}｜${c.title}｜${c.originalTitle ?? ""}｜${c.releaseDate ?? "未定"}`,
  );
  return [
    "## 見た映画",
    `「${context.visitTitle}」（見た日：${context.visitDate}）。この映画の上映前に流れた予告の話です。`,
    "",
    "## その時期に公開される映画の候補（TMDb。tmdb_id｜題名｜原題｜日本での公開日）",
    lines.length > 0 ? lines.join("\n") : "（取得できませんでした）",
  ].join("\n");
}

function latestUserText(context: AiContext): string {
  const rejected =
    context.rejectedTitles.length > 0
      ? `（「違う」とした作品：${context.rejectedTitles.map((t) => `「${t}」`).join("、")}）\n\n`
      : "";
  return `${rejected}${context.message}`;
}

type ShowCandidatesInput = {
  message?: unknown;
  candidates?: unknown;
};

function toSuggestions(raw: unknown): AiSuggestion[] {
  if (!Array.isArray(raw)) return [];
  const result: AiSuggestion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as Record<string, unknown>;
    const title = typeof c.title === "string" ? c.title.trim() : "";
    const originalTitle = typeof c.original_title === "string" ? c.original_title.trim() : "";
    if (!title && !originalTitle) continue;
    const tmdbId = Number.isInteger(c.tmdb_id) && (c.tmdb_id as number) > 0 ? (c.tmdb_id as number) : null;
    const year = Number.isInteger(c.year) && (c.year as number) > 1900 ? (c.year as number) : null;
    result.push({
      tmdbId,
      title: title || originalTitle,
      originalTitle: originalTitle || null,
      year,
      reason: typeof c.reason === "string" ? c.reason.trim() : "",
    });
    if (result.length >= MAX_AI_CANDIDATES) break;
  }
  return result;
}

/** 応答から、返答の本文と候補を取り出す。 */
export function parseAiResponse(response: Anthropic.Beta.BetaMessage): AiReply {
  if (response.stop_reason === "refusal") {
    throw new TrailerAiError("AI が返答を断りました", "refusal");
  }
  const tool = response.content.find(
    (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use" && b.name === "show_candidates",
  );
  if (tool) {
    const input = tool.input as ShowCandidatesInput;
    const message = typeof input.message === "string" ? input.message.trim() : "";
    const suggestions = toSuggestions(input.candidates);
    if (message || suggestions.length > 0) {
      return { message: message || "候補を挙げました。", suggestions };
    }
  }
  // ツールを呼ばずに終わったときは、本文だけを返答として扱う（候補は0件）。
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) throw new TrailerAiError(`AI の返答が空でした（${response.stop_reason}）`, "failed");
  return { message: text, suggestions: [] };
}

/** AI に相談する。失敗したら TrailerAiError を投げる（API キーなどの秘密情報はエラーに含めない）。 */
export async function askTrailerAi(context: AiContext): Promise<AiReply> {
  const client = new Anthropic({
    apiKey: getSecret("ANTHROPIC_API_KEY"),
    timeout: TIMEOUT_MS,
    maxRetries: 1,
  });

  let messages: Anthropic.Beta.BetaMessageParam[] = [
    ...context.history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: latestUserText(context) },
  ];
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: SYSTEM_PROMPT },
    { type: "text", text: huntContext(context), cache_control: { type: "ephemeral" } },
  ];

  try {
    let response: Anthropic.Beta.BetaMessage | null = null;
    for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
      response = await client.beta.messages.create({
        model: AI_MODEL,
        max_tokens: 16000,
        // 安全のための判定で断られたときは、Anthropic 側で別のモデルが続きを答える。
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        system,
        tools: [WEB_SEARCH_TOOL, SHOW_CANDIDATES_TOOL],
        messages,
      });
      logUsage(response);
      if (response.stop_reason !== "pause_turn") break;
      // 検索が長引いて止まったときは、応答をそのまま返して続きを頼む（「続けて」とは書き足さない）。
      messages = [...messages, { role: "assistant", content: response.content }];
    }
    if (!response) throw new TrailerAiError("AI から応答がありませんでした", "failed");
    return parseAiResponse(response);
  } catch (error) {
    if (error instanceof TrailerAiError) throw error;
    if (error instanceof Anthropic.APIError) {
      throw new TrailerAiError(
        `Anthropic の API がエラーを返しました（${error.status ?? error.name}）`,
        "failed",
      );
    }
    throw error;
  }
}

/** 費用の確認用に、使ったトークン数と検索回数をログに出す（本文は出さない）。 */
function logUsage(response: Anthropic.Beta.BetaMessage) {
  const u = response.usage;
  console.log(
    `AI の利用量: model=${response.model} stop=${response.stop_reason} input=${u.input_tokens} ` +
      `cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} ` +
      `output=${u.output_tokens} searches=${u.server_tool_use?.web_search_requests ?? 0}`,
  );
}
