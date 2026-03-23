import Link from "next/link";

const apiBase = process.env.API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:3001";
export const dynamic = "force-dynamic";

const humanize = (value: string) => value.split("_").join(" ");

interface Candidate {
  setupId: string;
  symbol: string;
  setupType: string;
  timeframe: string;
  confidence: number;
  entry: number | null;
  stop: number | null;
  target: number | null;
  riskReward: number | null;
  strategyWinRate: number;
  strategyExpectancyR: number;
}

interface Scorecard {
  key: string;
  setupType: string;
  timeframe: string;
  sampleSize: number;
  triggeredCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  expired: number;
  pending: number;
  winRate: number;
  expectancyR: number;
  averageReturnPct: number;
  averageHoldBars: number;
  averageConfidence: number;
}

interface Evaluation {
  setupId: string;
  symbol: string;
  setupType: string;
  timeframe: string;
  createdAt: string;
  confidence: number;
  outcome: string;
  entry: number | null;
  stop: number | null;
  target: number | null;
  holdBars: number;
  rMultiple: number | null;
  returnPct: number | null;
}

interface BacktestReport {
  generatedAt: string;
  scorecards: Scorecard[];
  topCandidates: Candidate[];
  recentEvaluations: Evaluation[];
}

const fetchJson = async <T,>(path: string): Promise<T | null> => {
  try {
    const res = await fetch(`${apiBase}${path}`);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
};

const formatPercent = (value: number | null) => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const formatSignedPercent = (value: number | null) => (value === null ? "-" : `${value.toFixed(2)}%`);
const formatNumber = (value: number | null, digits = 2) => (value === null ? "-" : value.toFixed(digits));

export default async function ResearchPage() {
  const report = await fetchJson<BacktestReport>("/api/backtests?limit=300");
  const scorecards = report?.scorecards ?? [];
  const candidates = report?.topCandidates ?? [];
  const evaluations = report?.recentEvaluations ?? [];

  return (
    <>
      <section className="hero-section">
        <div className="eyebrow">Research Lab</div>
        <h2>Backtest the ideas before they earn a spot on the board.</h2>
        <p className="hero-copy">
          These scorecards are computed from saved setups and provider price history so we can compare which
          patterns are actually carrying their weight.
        </p>
        <p className="muted">
          Generated: {report ? new Date(report.generatedAt).toLocaleString() : "No report yet"}
        </p>
      </section>

      <section>
        <div className="section-heading">
          <div>
            <h2>Strategy Scorecards</h2>
            <p>Expectancy and hit rate by setup family.</p>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Setup</th>
              <th>Timeframe</th>
              <th>Sample</th>
              <th>Triggered</th>
              <th>Closed</th>
              <th>Win Rate</th>
              <th>Expectancy</th>
              <th>Avg Hold</th>
            </tr>
          </thead>
          <tbody>
            {scorecards.map((scorecard) => (
              <tr key={scorecard.key}>
                <td>{humanize(scorecard.setupType)}</td>
                <td>{scorecard.timeframe}</td>
                <td>{scorecard.sampleSize}</td>
                <td>{scorecard.triggeredCount}</td>
                <td>{scorecard.closedCount}</td>
                <td>{formatPercent(scorecard.winRate)}</td>
                <td>{formatNumber(scorecard.expectancyR)}R</td>
                <td>{formatNumber(scorecard.averageHoldBars, 1)} bars</td>
              </tr>
            ))}
            {scorecards.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty-row">
                  No scorecards available yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>

      <section>
        <div className="section-heading">
          <div>
            <h2>Top Candidates</h2>
            <p>Watchlist ideas ranked using strategy scorecards and trade structure.</p>
          </div>
        </div>
        <div className="card-grid">
          {candidates.map((candidate) => (
            <div className="card setup-card" key={candidate.setupId}>
              <div className="card-topline">
                <span className="badge">{candidate.symbol}</span>
                <span className="muted">{candidate.timeframe}</span>
              </div>
              <h3>{humanize(candidate.setupType)}</h3>
              <div className="detail-grid">
                <span>Confidence</span>
                <strong>{candidate.confidence.toFixed(0)}</strong>
                <span>Entry / Stop</span>
                <strong>
                  {formatNumber(candidate.entry)} / {formatNumber(candidate.stop)}
                </strong>
                <span>Target</span>
                <strong>{formatNumber(candidate.target)}</strong>
                <span>Risk / Reward</span>
                <strong>{formatNumber(candidate.riskReward)}R</strong>
                <span>Strategy Win Rate</span>
                <strong>{formatPercent(candidate.strategyWinRate)}</strong>
                <span>Expectancy</span>
                <strong>{formatNumber(candidate.strategyExpectancyR)}R</strong>
              </div>
              <Link href={`/symbols/${candidate.symbol}`} className="inline-link">
                Open {candidate.symbol}
              </Link>
            </div>
          ))}
          {candidates.length === 0 ? (
            <div className="card empty-card">
              <h3>No candidates yet</h3>
              <p>Populate setups first, then this view will highlight the strongest ideas.</p>
            </div>
          ) : null}
        </div>
      </section>

      <section>
        <div className="section-heading">
          <div>
            <h2>Recent Evaluations</h2>
            <p>Most recent setup simulations, including outcome and normalized return.</p>
          </div>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Created</th>
              <th>Symbol</th>
              <th>Setup</th>
              <th>Outcome</th>
              <th>Hold</th>
              <th>R</th>
              <th>Return</th>
            </tr>
          </thead>
          <tbody>
            {evaluations.map((evaluation) => (
              <tr key={evaluation.setupId}>
                <td>{new Date(evaluation.createdAt).toLocaleDateString()}</td>
                <td>{evaluation.symbol}</td>
                <td>{humanize(evaluation.setupType)}</td>
                <td>{humanize(evaluation.outcome)}</td>
                <td>{evaluation.holdBars}</td>
                <td>{formatNumber(evaluation.rMultiple)}R</td>
                <td className={(evaluation.returnPct ?? 0) >= 0 ? "positive" : "negative"}>
                  {formatSignedPercent(evaluation.returnPct)}
                </td>
              </tr>
            ))}
            {evaluations.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-row">
                  No evaluations available yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
