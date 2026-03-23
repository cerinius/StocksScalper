"use client";

import useSWR from "swr";
import { Panel, ScreenHeader, StatusPill } from "../../components/screen";
import { fetcher, formatDateTime } from "../../lib/api";

interface NewsResponseItem {
  id: string;
  headline: string;
  source: string;
  urgency: string;
  directionalBias: string;
  volatilityImpact: string;
  relevanceScore: number;
  confidence: number;
  summary: string;
  originalTimestamp: string;
  symbolLinks: Array<{ symbol: { ticker: string } }>;
}

export default function NewsPage() {
  const { data } = useSWR<NewsResponseItem[]>("/api/news?limit=40", fetcher, { refreshInterval: 10_000 });

  return (
    <>
      <ScreenHeader
        eyebrow="News Intelligence"
        title="Market-moving information flow"
        description="Breaking macro, sector, and symbol-specific events scored for urgency, bias, volatility impact, and downstream trading relevance."
      />
      <Panel title="Latest Intelligence" subtitle="Deduplicated events ranked by urgency and relevance.">
        <div className="list-stack">
          {(data ?? []).map((item) => (
            <div className="list-item" key={item.id}>
              <div className="button-row">
                <StatusPill value={item.urgency} />
                <StatusPill value={item.directionalBias} />
                <StatusPill value={item.volatilityImpact} />
              </div>
              <p><strong>{item.headline}</strong></p>
              <p>{item.summary}</p>
              <small>
                {item.source} · {item.symbolLinks.map((link) => link.symbol.ticker).join(", ") || "Macro"} · {formatDateTime(item.originalTimestamp)}
              </small>
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
