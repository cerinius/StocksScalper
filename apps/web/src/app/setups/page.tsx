const apiBase = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";
export const dynamic = "force-dynamic";

interface SetupItem {
  id: string;
  setupType: string;
  confidence: number;
  status: string;
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

export default async function SetupsPage() {
  const swing = await fetchJson<SetupItem[]>("/api/setups?status=watch&tf=swing", []);
  const scalp = await fetchJson<SetupItem[]>("/api/setups?status=watch&tf=scalp", []);

  return (
    <>
      <section>
        <h2>Swing Setups</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Type</th>
              <th>Confidence</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {swing.map((item) => (
              <tr key={item.id}>
                <td>{item.symbol?.ticker}</td>
                <td>{item.setupType}</td>
                <td>{item.confidence}</td>
                <td>{item.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Scalp Setups</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Type</th>
              <th>Confidence</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {scalp.map((item) => (
              <tr key={item.id}>
                <td>{item.symbol?.ticker}</td>
                <td>{item.setupType}</td>
                <td>{item.confidence}</td>
                <td>{item.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}
