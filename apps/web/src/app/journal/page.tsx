const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

const fetchJson = async (path: string) => {
  const res = await fetch(`${apiBase}${path}`, { next: { revalidate: 10 } });
  if (!res.ok) return [];
  return res.json();
};

export default async function JournalPage() {
  const entries = await fetchJson("/api/journal");

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
          {entries.map((entry: any) => (
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
