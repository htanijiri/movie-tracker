import { STATE_LABELS, type StateKey } from "~/lib/labels";

const COLORS: Record<StateKey, string> = {
  theater: "bg-amber-400 text-zinc-950",
  streaming: "bg-sky-400 text-zinc-950",
  watched: "bg-emerald-400 text-zinc-950",
  skipped: "bg-zinc-600 text-zinc-100",
  other: "bg-zinc-600 text-zinc-100",
};

/** 自分の登録状態（劇場で見たい／サブスク待ち／視聴済み／見送り）を示すラベル。 */
export function StateBadge({
  state,
  className = "",
}: {
  state: StateKey;
  className?: string;
}) {
  const { emoji, label } = STATE_LABELS[state];
  return (
    <span
      data-state={state}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold leading-tight ${COLORS[state]} ${className}`}
    >
      <span aria-hidden="true">{emoji}</span>
      {label}
    </span>
  );
}
