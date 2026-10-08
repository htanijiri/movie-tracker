import { useState } from "react";
import { useFetcher } from "react-router";

import { formatYmd } from "~/lib/date";
import {
  DISCOVERY_TYPES,
  WATCHED_MEDIUMS,
  type UserMovie,
  type WatchedMedium,
} from "~/lib/db/schema";
import type { PlaceSuggestions } from "~/lib/db/user-movies.server";
import { formatDiscovery, formatStars, hasDiscovery } from "~/lib/format";
import {
  DISCOVERY_TYPE_LABELS,
  MEDIUM_BUTTON_LABELS,
  SELECTABLE_MEDIUMS,
  WATCHED_MEDIUM_LABELS,
} from "~/lib/labels";
import { LIMITS, type FieldErrors } from "~/lib/validation";

// 映画詳細の画面の「自分の記録」。
// 見たい（仕様書 004）、きっかけ（005）、見た記録（006）をまとめて扱う。
// どの操作も同じ画面の action に POST し、intent で区別する。

export type ActionResult =
  | { ok: true; intent: string }
  | { ok: false; intent: string; errors: FieldErrors; values: Record<string, string> };

type Props = {
  record: UserMovie | null;
  today: string;
  suggestions: PlaceSuggestions;
  /** JavaScript が動かないときの、フォーム送信の結果。 */
  actionData?: ActionResult;
};

/** あるフォームの送信結果（エラーと、入力し直すための値）を取り出す。 */
function resultFor(
  intent: string,
  fetcherData: ActionResult | undefined,
  actionData: ActionResult | undefined,
) {
  const result = fetcherData ?? (actionData?.intent === intent ? actionData : undefined);
  if (result && !result.ok) return { errors: result.errors, values: result.values };
  return { errors: {} as FieldErrors, values: undefined };
}

/**
 * 開閉できる入力欄の状態。保存に成功したら閉じる。
 * 送信結果が変わったことを描画中に検知して状態を更新する（effect の中で setState しないため）。
 */
function useCloseOnSuccess(
  result: ActionResult | undefined,
  idle: boolean,
  initialOpen: boolean,
) {
  const [open, setOpen] = useState(initialOpen);
  const [handled, setHandled] = useState(result);
  if (idle && result !== handled) {
    setHandled(result);
    if (result?.ok) setOpen(false);
  }
  return [open, setOpen] as const;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="error-text mt-1">
      {message}
    </p>
  );
}

const chipClass =
  "inline-flex min-h-10 cursor-pointer items-center rounded-full border border-zinc-700 px-3 text-sm text-zinc-200 has-[:checked]:border-amber-400 has-[:checked]:bg-amber-400 has-[:checked]:font-bold has-[:checked]:text-zinc-950 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-amber-400";

export function MyRecord({ record, today, suggestions, actionData }: Props) {
  const watched = record?.status === "WATCHED";
  return (
    <section aria-labelledby="my-record-title" className="panel">
      <h2 id="my-record-title" className="sr-only">
        自分の記録
      </h2>

      {watched ? (
        <WatchedSummary
          record={record}
          today={today}
          suggestions={suggestions}
          actionData={actionData}
        />
      ) : (
        <>
          <MediumButtons record={record} />
          <WatchedForm
            record={record}
            today={today}
            suggestions={suggestions}
            actionData={actionData}
          />
        </>
      )}

      {record && (
        <DiscoverySection
          record={record}
          today={today}
          suggestions={suggestions}
          actionData={actionData}
        />
      )}

      {record && !watched && <RemoveSection />}
    </section>
  );
}

/** 「劇場で見たい／サブスクで見たい／見送る」の3つのボタン。押した時点で登録される。 */
function MediumButtons({ record }: { record: UserMovie | null }) {
  const fetcher = useFetcher<ActionResult>();
  // 送信中は、押したボタンを先に強調する。
  const pending = fetcher.formData?.get("medium");
  const selected =
    typeof pending === "string"
      ? pending
      : record && record.status !== "WATCHED"
        ? record.preferredMedium
        : null;

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="set-medium" />
      <div className="grid grid-cols-3 gap-2" role="group" aria-label="どこまでなら見たいか">
        {SELECTABLE_MEDIUMS.map((medium) => {
          const { emoji, label, parts } = MEDIUM_BUTTON_LABELS[medium];
          const pressed = selected === medium;
          return (
            <button
              key={medium}
              type="submit"
              name="medium"
              value={medium}
              aria-pressed={pressed}
              // 見た目は途中で改行するが、読み上げでは1つの言葉として伝える。
              aria-label={label}
              className={`btn min-h-16 flex-col gap-0.5 px-1 text-xs leading-tight ${
                pressed ? "btn-primary" : ""
              }`}
            >
              <span aria-hidden="true" className="text-xl leading-none">
                {emoji}
              </span>
              <span>
                {parts.map((part) => (
                  <span key={part} className="inline-block">
                    {part}
                  </span>
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </fetcher.Form>
  );
}

/** 視聴方法ごとの、場所・サービス名の入力欄の説明。 */
const PLACE_HINTS: Record<WatchedMedium, string> = {
  THEATER: "映画館の名前",
  STREAMING: "配信サービスの名前",
  RENTAL: "サービスや店の名前",
  OTHER: "場所や方法",
};

/** 見た記録の入力欄（新しく付けるときと、編集するときの両方で使う）。 */
function WatchedFields({
  record,
  today,
  suggestions,
  errors,
  values,
}: {
  record: UserMovie | null;
  today: string;
  suggestions: PlaceSuggestions;
  errors: FieldErrors;
  values?: Record<string, string>;
}) {
  // 「劇場で見たい」にしていた映画は劇場、「サブスクで見たい」にしていた映画はサブスク配信を、最初から選んでおく。
  const preferredDefault: WatchedMedium | "" =
    record?.preferredMedium === "THEATER"
      ? "THEATER"
      : record?.preferredMedium === "STREAMING"
        ? "STREAMING"
        : "";
  const initialMedium = (values?.medium ?? record?.watchedMedium ?? preferredDefault) as
    | WatchedMedium
    | "";
  const initialRating = values?.rating ?? (record?.rating ? String(record.rating) : "");

  const [medium, setMedium] = useState<WatchedMedium | "">(initialMedium);
  const [rating, setRating] = useState(initialRating);
  const placeOptions = medium ? suggestions.watched[medium] : [];

  return (
    <div className="mt-3 space-y-4">
      <div>
        <label htmlFor="watchedAt" className="field-label">
          見た日
        </label>
        <input
          id="watchedAt"
          type="date"
          name="watchedAt"
          required
          max={today}
          defaultValue={values?.watchedAt ?? record?.watchedAt ?? today}
          className="field"
        />
        <FieldError message={errors.watchedAt} />
      </div>

      <fieldset>
        <legend className="field-label">視聴方法</legend>
        <div className="flex flex-wrap gap-2">
          {WATCHED_MEDIUMS.map((m) => (
            <label key={m} className={chipClass}>
              <input
                type="radio"
                name="watchedMedium"
                value={m}
                required
                checked={medium === m}
                onChange={() => setMedium(m)}
                className="sr-only"
              />
              {WATCHED_MEDIUM_LABELS[m]}
            </label>
          ))}
        </div>
        <FieldError message={errors.watchedMedium} />
      </fieldset>

      <div>
        <label htmlFor="watchedPlace" className="field-label">
          場所・サービス名 <span className="font-normal text-muted">（任意）</span>
        </label>
        <input
          id="watchedPlace"
          type="text"
          name="place"
          list="watched-place-options"
          maxLength={LIMITS.place}
          defaultValue={values?.place ?? record?.watchedPlace ?? ""}
          placeholder={medium ? PLACE_HINTS[medium] : "映画館や配信サービスの名前"}
          autoComplete="off"
          className="field"
        />
        <datalist id="watched-place-options">
          {placeOptions.map((place) => (
            <option key={place} value={place} />
          ))}
        </datalist>
        <FieldError message={errors.place} />
      </div>

      <fieldset>
        <legend className="field-label">
          評価 <span className="font-normal text-muted">（任意）</span>
        </legend>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <label
              key={n}
              className={`flex h-11 w-11 cursor-pointer items-center justify-center rounded-lg text-3xl leading-none has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-amber-400 ${
                rating !== "" && n <= Number(rating) ? "text-amber-400" : "text-zinc-600"
              }`}
            >
              <input
                type="radio"
                name="rating"
                value={n}
                checked={rating === String(n)}
                onChange={() => setRating(String(n))}
                className="sr-only"
              />
              <span aria-hidden="true">★</span>
              <span className="sr-only">★{n}</span>
            </label>
          ))}
          <label className="ml-2 inline-flex min-h-9 cursor-pointer items-center rounded-full border border-zinc-700 px-3 text-xs text-zinc-300 has-[:checked]:border-zinc-400 has-[:checked]:text-zinc-100">
            <input
              type="radio"
              name="rating"
              value=""
              checked={rating === ""}
              onChange={() => setRating("")}
              className="sr-only"
            />
            なし
          </label>
        </div>
        <FieldError message={errors.rating} />
      </fieldset>

      <div>
        <label htmlFor="review" className="field-label">
          感想 <span className="font-normal text-muted">（任意）</span>
        </label>
        <textarea
          id="review"
          name="review"
          rows={4}
          maxLength={LIMITS.review}
          defaultValue={values?.review ?? record?.review ?? ""}
          className="field"
        />
        <FieldError message={errors.review} />
      </div>
    </div>
  );
}

/** まだ見ていない映画に、見た記録を付けるフォーム。「見た」を押すと開く。 */
function WatchedForm({ record, today, suggestions, actionData }: Props) {
  const fetcher = useFetcher<ActionResult>();
  const { errors, values } = resultFor("save-watched", fetcher.data, actionData);
  const hasErrors = Object.keys(errors).length > 0;

  return (
    <details className="mt-3" open={hasErrors || undefined}>
      <summary className="btn w-full cursor-pointer list-none">
        <span aria-hidden="true">✅</span> 見た
      </summary>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="save-watched" />
        <WatchedFields
          record={record}
          today={today}
          suggestions={suggestions}
          errors={errors}
          values={values}
        />
        <button
          type="submit"
          className="btn btn-primary mt-4 w-full"
          disabled={fetcher.state !== "idle"}
        >
          保存
        </button>
      </fetcher.Form>
    </details>
  );
}

/** 見た記録の表示と、編集・取り消し。 */
function WatchedSummary({
  record,
  today,
  suggestions,
  actionData,
}: Props & { record: UserMovie }) {
  const fetcher = useFetcher<ActionResult>();
  const unwatchFetcher = useFetcher<ActionResult>();
  const { errors, values } = resultFor("save-watched", fetcher.data, actionData);
  const hasErrors = Object.keys(errors).length > 0;
  const [editing, setEditing] = useCloseOnSuccess(
    fetcher.data,
    fetcher.state === "idle",
    hasErrors,
  );

  const stars = formatStars(record.rating);
  const directly = record.preferredMedium === null;

  return (
    <div data-watched="summary">
      <p className="text-sm font-bold text-emerald-300">
        <span aria-hidden="true">✅</span> 視聴済み
      </p>
      <dl className="mt-2 space-y-1 text-sm">
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted">見た日</dt>
          <dd>{formatYmd(record.watchedAt)}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-muted">視聴方法</dt>
          <dd>
            {[
              record.watchedMedium ? WATCHED_MEDIUM_LABELS[record.watchedMedium] : "",
              record.watchedPlace ? `（${record.watchedPlace}）` : "",
            ].join("")}
          </dd>
        </div>
        {stars && (
          <div className="flex gap-2">
            <dt className="w-20 shrink-0 text-muted">評価</dt>
            <dd className="text-amber-400" aria-label={`★${record.rating}`}>
              {stars}
            </dd>
          </div>
        )}
      </dl>
      {record.review && (
        // 改行をそのまま表示する。React が HTML をエスケープするので、タグは文字として出る。
        <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed" data-review>
          {record.review}
        </p>
      )}

      <details
        className="mt-3"
        open={editing}
        onToggle={(event) => setEditing(event.currentTarget.open)}
      >
        <summary className="btn cursor-pointer list-none">見た記録を編集</summary>
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="save-watched" />
          <WatchedFields
            record={record}
            today={today}
            suggestions={suggestions}
            errors={errors}
            values={values}
          />
          <button
            type="submit"
            className="btn btn-primary mt-4 w-full"
            disabled={fetcher.state !== "idle"}
          >
            保存
          </button>
        </fetcher.Form>
      </details>

      <details className="mt-2">
        <summary className="btn btn-quiet cursor-pointer list-none text-xs">
          見た記録を取り消す
        </summary>
        <div className="mt-2 rounded-lg border border-red-900 p-3">
          <p className="text-sm">
            見た日・評価・感想が消えます。
            {directly
              ? "この映画はリストから消えます。"
              : "「見たい」に登録していたときの状態に戻ります。"}
          </p>
          <unwatchFetcher.Form method="post" className="mt-2">
            <input type="hidden" name="intent" value="unwatch" />
            <button
              type="submit"
              className="btn btn-danger"
              disabled={unwatchFetcher.state !== "idle"}
            >
              取り消す
            </button>
          </unwatchFetcher.Form>
        </div>
      </details>
    </div>
  );
}

/** 知ったきっかけ（任意）。未入力なら「きっかけを書く」、入力済みなら1行表示と編集。 */
function DiscoverySection({
  record,
  today,
  suggestions,
  actionData,
}: Props & { record: UserMovie }) {
  const fetcher = useFetcher<ActionResult>();
  const clearFetcher = useFetcher<ActionResult>();
  const { errors, values } = resultFor("save-discovery", fetcher.data, actionData);
  const hasErrors = Object.keys(errors).length > 0;
  const [open, setOpen] = useCloseOnSuccess(
    fetcher.data,
    fetcher.state === "idle",
    hasErrors,
  );

  const filled = hasDiscovery(record);
  const line = formatDiscovery(record);

  return (
    <div className="mt-4 border-t border-zinc-800 pt-3" data-discovery>
      {filled && (
        <p className="text-sm">
          <span className="text-muted">きっかけ：</span>
          {line}
        </p>
      )}
      <details
        className={filled ? "mt-2" : ""}
        open={open}
        onToggle={(event) => setOpen(event.currentTarget.open)}
      >
        <summary className="btn btn-quiet cursor-pointer list-none text-xs">
          {filled ? "きっかけを編集" : "＋ きっかけを書く"}
        </summary>
        <fetcher.Form method="post" className="mt-3 space-y-4">
          <input type="hidden" name="intent" value="save-discovery" />

          <fieldset>
            <legend className="field-label">どこで知った？</legend>
            <div className="flex flex-wrap gap-2">
              {DISCOVERY_TYPES.map((type) => (
                <label key={type} className={chipClass}>
                  <input
                    type="radio"
                    name="type"
                    value={type}
                    defaultChecked={(values?.type ?? record.discoveryType ?? "") === type}
                    className="sr-only"
                  />
                  {DISCOVERY_TYPE_LABELS[type]}
                </label>
              ))}
            </div>
            <FieldError message={errors.type} />
          </fieldset>

          <div>
            <label htmlFor="discoveryDate" className="field-label">
              日付
            </label>
            <input
              id="discoveryDate"
              type="date"
              name="date"
              // 未入力で開いたときだけ、今日の日付を入れておく。
              defaultValue={values?.date ?? record.discoveryDate ?? (filled ? "" : today)}
              className="field"
            />
            <FieldError message={errors.date} />
          </div>

          <div>
            <label htmlFor="discoveryPlace" className="field-label">
              場所 <span className="font-normal text-muted">（任意）</span>
            </label>
            <input
              id="discoveryPlace"
              type="text"
              name="place"
              list="discovery-place-options"
              maxLength={LIMITS.place}
              defaultValue={values?.place ?? record.discoveryPlace ?? ""}
              placeholder="映画館の名前など"
              autoComplete="off"
              className="field"
            />
            <datalist id="discovery-place-options">
              {suggestions.discovery.map((place) => (
                <option key={place} value={place} />
              ))}
            </datalist>
            <FieldError message={errors.place} />
          </div>

          <div>
            <label htmlFor="discoveryNote" className="field-label">
              メモ <span className="font-normal text-muted">（任意）</span>
            </label>
            <input
              id="discoveryNote"
              type="text"
              name="note"
              maxLength={LIMITS.note}
              defaultValue={values?.note ?? record.discoveryNote ?? ""}
              placeholder="例：「映画A」の上映前"
              autoComplete="off"
              className="field"
            />
            <FieldError message={errors.note} />
          </div>

          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={fetcher.state !== "idle"}
          >
            きっかけを保存
          </button>
        </fetcher.Form>

        {filled && (
          // すべての項目を空にして保存する（＝きっかけを消す）。
          <clearFetcher.Form method="post" className="mt-2">
            <input type="hidden" name="intent" value="save-discovery" />
            <input type="hidden" name="type" value="" />
            <input type="hidden" name="date" value="" />
            <input type="hidden" name="place" value="" />
            <input type="hidden" name="note" value="" />
            <button
              type="submit"
              className="btn btn-quiet w-full text-xs"
              disabled={clearFetcher.state !== "idle"}
            >
              きっかけを消す
            </button>
          </clearFetcher.Form>
        )}
      </details>
    </div>
  );
}

/** 登録の取り消し。きっかけも消えるので、押す前に確認を挟む。 */
function RemoveSection() {
  const fetcher = useFetcher<ActionResult>();
  return (
    <details className="mt-2">
      <summary className="btn btn-quiet cursor-pointer list-none text-xs">
        登録を取り消す
      </summary>
      <div className="mt-2 rounded-lg border border-red-900 p-3">
        <p className="text-sm">この映画をリストから消します。きっかけも一緒に消えます。</p>
        <fetcher.Form method="post" className="mt-2">
          <input type="hidden" name="intent" value="remove" />
          <button
            type="submit"
            className="btn btn-danger"
            disabled={fetcher.state !== "idle"}
          >
            リストから消す
          </button>
        </fetcher.Form>
      </div>
    </details>
  );
}
