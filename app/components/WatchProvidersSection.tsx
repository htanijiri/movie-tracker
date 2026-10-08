import { JUSTWATCH_URL } from "~/lib/site";
import { logoUrl } from "~/lib/tmdb/images";
import type { Provider, WatchProviders } from "~/lib/tmdb/types";

function ProviderList({ label, providers }: { label: string; providers: Provider[] }) {
  if (providers.length === 0) return null;
  return (
    <div className="mt-3" data-provider-group={label}>
      <h3 className="text-xs font-bold text-zinc-300">{label}</h3>
      <ul className="mt-1.5 flex flex-wrap gap-2">
        {providers.map((provider) => {
          const logo = logoUrl(provider.logoPath);
          return (
            <li
              key={provider.id}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-800 py-1 pl-1 pr-2 text-xs"
            >
              {logo && (
                <img
                  src={logo}
                  alt=""
                  width={24}
                  height={24}
                  loading="lazy"
                  className="h-6 w-6 rounded"
                />
              )}
              {provider.name}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** 日本での配信状況。データは TMDb 経由の JustWatch 提供で、その表記を必ず出す。 */
export function WatchProvidersSection({ providers }: { providers: WatchProviders | null }) {
  return (
    <section aria-labelledby="providers-title">
      <h2 id="providers-title" className="section-title">
        配信状況（日本）
      </h2>
      {providers ? (
        <>
          <ProviderList label="定額で見られる" providers={providers.flatrate} />
          <ProviderList label="レンタル・購入" providers={providers.rentOrBuy} />
          <ProviderList label="無料" providers={providers.free} />
          {providers.link && (
            <p className="mt-3 text-xs">
              <a href={providers.link} target="_blank" rel="noreferrer" className="underline">
                配信サービスへのリンクを TMDb で見る
              </a>
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-sm text-muted">日本での配信情報はまだありません。</p>
      )}
      <p className="mt-2 text-[11px] text-muted">
        <a href={JUSTWATCH_URL} target="_blank" rel="noreferrer" className="underline">
          JustWatch
        </a>{" "}
        提供。実際の配信状況と異なる場合があります。
      </p>
    </section>
  );
}
