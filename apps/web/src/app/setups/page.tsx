const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";

const fetchJson = async (path: string) => {
  const res = await fetch(`${apiBase}${path}`, { next: { revalidate: 10 } });
  if (!res.ok) return [];
  return res.json();
};

export default async function SetupsPage() {
  const swing = await fetchJson("/api/setups?status=watch&tf=swing");
  const scalp = await fetchJson("/api/setups?status=watch&tf=scalp");

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
            {swing.map((item: any) => (
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
            {scalp.map((item: any) => (
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
