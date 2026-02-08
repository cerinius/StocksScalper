const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

const fetchJson = async (path: string) => {
  const res = await fetch(`${apiBase}${path}`, { next: { revalidate: 10 } });
  if (!res.ok) return null;
  return res.json();
};

export default async function HomePage() {
  const universe = await fetchJson("/api/universe/current");
  const items = universe?.items ?? [];

  return (
    <>
      <section>
        <h2>Current Top 100</h2>
        <p>Weekly ranked universe with liquidity, volatility, and catalyst scoring.</p>
        <table className="table">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Ticker</th>
              <th>Total Score</th>
              <th>Dollar Vol</th>
              <th>ATR%</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item: any) => (
              <tr key={item.id}>
                <td>{item.rank}</td>
                <td>{item.symbol?.ticker}</td>
                <td>{item.totalScore.toFixed(1)}</td>
                <td>${(item.metrics?.dollarVolume ?? 0).toLocaleString()}</td>
                <td>{(item.metrics?.atrPct ?? 0).toFixed(2)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>In-play Today</h2>
        <div className="card-grid">
          {items.slice(0, 4).map((item: any) => (
            <div className="card" key={`inplay-${item.id}`}>
              <div className="badge">{item.symbol?.ticker}</div>
              <h3>Score {item.totalScore.toFixed(1)}</h3>
              <p>RVOL {item.metrics?.rvol?.toFixed?.(2) ?? "-"}</p>
              <p>Trend {item.metrics?.trendScore?.toFixed?.(2) ?? "-"}</p>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
