const apiBase = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";
export const dynamic = "force-dynamic";

interface JournalEntry {
  id: string;
  setupType: string;
  entry: number;
  stop: number;
  target: number;
  pnl: number | null;
  symbol?: {
    ticker?: string;
  };
}

const fetchJson = async <T,>(path: string, fallback: T): Promise<T> => {
  try {
    const res = await fetch(`${apiBase}${path}`, { cache: "no-store" });
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
};

export default async function JournalPage() {
  const entries = await fetchJson<JournalEntry[]>("/api/journal", []);

  return (
    <>
      <div className="screen-header">
        <div>
          <div className="eyebrow">Journal</div>
          <h1>Realised trade history</h1>
          <p>Closed trades with entry, stop, target, and final P&amp;L. For open decisions and blockers, see Execution or Audit.</p>
        </div>
      </div>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h2>Trade journal</h2>
            <p>Every closed trade is listed here with the setup that produced it.</p>
          </div>
        </div>
        {entries.length === 0 ? (
          <div className="empty-state reason-no_data_yet">
            <div className="empty-state-icon">🕓</div>
            <h3 className="empty-state-title">No trades closed yet</h3>
            <p className="empty-state-body">Closed positions will appear here with their realised P&amp;L.</p>
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Setup</th>
                  <th className="align-right">Entry</th>
                  <th className="align-right">Stop</th>
                  <th className="align-right">Target</th>
                  <th className="align-right">P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <strong>{entry.symbol?.ticker ?? "—"}</strong>
                    </td>
                    <td>{entry.setupType}</td>
                    <td className="align-right">{entry.entry.toFixed(4)}</td>
                    <td className="align-right">{entry.stop.toFixed(4)}</td>
                    <td className="align-right">{entry.target.toFixed(4)}</td>
                    <td className="align-right">
                      {entry.pnl === null || entry.pnl === undefined
                        ? "—"
                        : `${entry.pnl >= 0 ? "+" : ""}${entry.pnl.toFixed(2)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
