"use client";

import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher } from "../../lib/api";

interface ValidationItem {
  id: string;
  status: string;
  finalValidationScore: number;
  winRateEstimate: number;
  expectancy: number;
  sampleSize: number;
  candidate: { symbol: { ticker: string }; strategyType: string; timeframe: string };
  backtestResults: Array<{ id: string; similarityScore: number; outcomeR: number; holdBars: number }>;
}

export default function ValidationPage() {
  const { data } = useSWR<ValidationItem[]>("/api/validation?limit=30", fetcher, { refreshInterval: 10_000 });

  return (
    <>
      <ScreenHeader
        eyebrow="Validation"
        title="Historical analogs and rule-based scoring"
        description="Audit how each candidate performed against comparable market structures, expectancy, drawdown, and analog sample quality."
      />
      <Panel title="Validation runs" subtitle="Backtesting and analog-based context for each candidate.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Strategy</th>
              <th>Timeframe</th>
              <th>Status</th>
              <th>Score</th>
              <th>Win Rate</th>
              <th>Expectancy</th>
              <th>Sample</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((item) => (
              <tr key={item.id}>
                <td>{item.candidate.symbol.ticker}</td>
                <td>{item.candidate.strategyType}</td>
                <td>{item.candidate.timeframe}</td>
                <td><StatusPill value={item.status} /></td>
                <td>{item.finalValidationScore.toFixed(1)}</td>
                <td>{(item.winRateEstimate * 100).toFixed(1)}%</td>
                <td>{item.expectancy.toFixed(2)}R</td>
                <td>{item.sampleSize}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
