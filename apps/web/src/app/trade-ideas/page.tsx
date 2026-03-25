"use client";

import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatDateTime } from "../../lib/api";

interface TradeIdea {
  id: string;
  timeframe: string;
  direction: string;
  strategyType: string;
  volatilityClassification: string;
  confidenceScore: number;
  setupScore: number;
  riskReward: number;
  status: string;
  detectedAt: string;
  symbol: { ticker: string };
}

export default function TradeIdeasPage() {
  const { data } = useSWR<TradeIdea[]>("/api/trade-ideas?limit=50", fetcher, { refreshInterval: 5000 });

  return (
    <>
      <ScreenHeader
        eyebrow="Trade Ideas"
        title="Ranked chart and context candidates"
        description="See what the market analysis layer is surfacing across watchlists, timeframes, and strategy templates."
      />
      <Panel title="Current candidates" subtitle="Promising opportunities with explainable scores and trade structure.">
        <table className="data-table">
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Timeframe</th>
              <th>Direction</th>
              <th>Strategy</th>
              <th>Regime</th>
              <th>Setup</th>
              <th>Confidence</th>
              <th>R/R</th>
              <th>Status</th>
              <th>Detected</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((idea) => (
              <tr key={idea.id}>
                <td>{idea.symbol.ticker}</td>
                <td>{idea.timeframe}</td>
                <td>{idea.direction}</td>
                <td>{idea.strategyType}</td>
                <td><StatusPill value={idea.volatilityClassification} /></td>
                <td>{idea.setupScore.toFixed(1)}</td>
                <td>{idea.confidenceScore.toFixed(1)}</td>
                <td>{idea.riskReward.toFixed(2)}</td>
                <td><StatusPill value={idea.status} /></td>
                <td>{formatDateTime(idea.detectedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </>
  );
}
