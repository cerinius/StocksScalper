interface SymbolPageProps {
  params: { ticker: string };
}

const apiBase = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";
export const dynamic = "force-dynamic";

interface SymbolSummary {
  latestFeature?: {
    atrPct?: number;
    rvol?: number;
  };
  latestLevel?: {
    weekHigh?: number;
  };
}

interface NewsItem {
  id: string;
  headline: string;
  source: string;
}

interface SetupItem {
  id: string;
  setupType: string;
  timeframe: string;
  confidence: number;
  symbol?: {
    ticker?: string;
  };
}

const fetchJson = async <T,>(path: string, fallback: T): Promise<T> => {
  try {
    const res = await fetch(`${apiBase}${path}`);
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
};

export default async function SymbolPage({ params }: SymbolPageProps) {
  const summary = await fetchJson<SymbolSummary | null>(`/api/symbol/${params.ticker}/summary`, null);
  const news = await fetchJson<NewsItem[]>(`/api/symbol/${params.ticker}/news?days=7`, []);
  const setups = await fetchJson<SetupItem[]>(`/api/setups?status=watch`, []);

  return (
    <>
      <section>
        <h2>{params.ticker} Overview</h2>
        <div className="card-grid">
          <div className="card">
            <h3>ATR%</h3>
            <p>{summary?.latestFeature?.atrPct ?? "-"}</p>
          </div>
          <div className="card">
            <h3>RVOL</h3>
            <p>{summary?.latestFeature?.rvol ?? "-"}</p>
          </div>
          <div className="card">
            <h3>Weekly High</h3>
            <p>{summary?.latestLevel?.weekHigh ?? "-"}</p>
          </div>
        </div>
      </section>

      <section>
        <h2>News</h2>
        <ul>
          {news.map((item) => (
            <li key={item.id}>
              <strong>{item.headline}</strong> - {item.source}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>Setup Candidates</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Timeframe</th>
              <th>Confidence</th>
            </tr>
          </thead>
          <tbody>
            {setups
              .filter((item) => item.symbol?.ticker === params.ticker)
              .map((item) => (
                <tr key={item.id}>
                  <td>{item.setupType}</td>
                  <td>{item.timeframe}</td>
                  <td>{item.confidence}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
