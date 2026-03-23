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
    const res = await fetch(`${apiBase}${path}`);
    if (!res.ok) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  }
};

export default async function JournalPage() {
  const entries = await fetchJson<JournalEntry[]>("/api/journal", []);

  return (
    <section>
      <h2>Trade Journal</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Setup</th>
            <th>Entry</th>
            <th>Stop</th>
            <th>Target</th>
            <th>PNL</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{entry.symbol?.ticker}</td>
              <td>{entry.setupType}</td>
              <td>{entry.entry}</td>
              <td>{entry.stop}</td>
              <td>{entry.target}</td>
              <td>{entry.pnl ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
