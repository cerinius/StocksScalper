interface SymbolPageProps {
  params: { ticker: string };
}

const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

const fetchJson = async (path: string) => {
  const res = await fetch(`${apiBase}${path}`, { next: { revalidate: 10 } });
  if (!res.ok) return null;
  return res.json();
};

export default async function SymbolPage({ params }: SymbolPageProps) {
  const summary = await fetchJson(`/api/symbol/${params.ticker}/summary`);
  const news = await fetchJson(`/api/symbol/${params.ticker}/news?days=7`);
  const setups = await fetchJson(`/api/setups?status=watch`);

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
          {news?.map((item: any) => (
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
              ?.filter((item: any) => item.symbol?.ticker === params.ticker)
              .map((item: any) => (
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
