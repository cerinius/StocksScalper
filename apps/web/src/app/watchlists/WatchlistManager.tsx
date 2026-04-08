"use client";

import React, { useEffect, useState } from "react";
import { apiBase } from "../../lib/api";

type Symbol = {
  id: string;
  ticker: string;
};

type WatchlistItem = {
  id: string;
  symbol: Symbol;
};

type Watchlist = {
  id: string;
  name: string;
  isActive: boolean;
  items: WatchlistItem[];
};

export default function WatchlistManager() {
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [newWatchlistName, setNewWatchlistName] = useState("");
  const [newSymbol, setNewSymbol] = useState<{ [key: string]: string }>({});

  const fetchWatchlists = async () => {
    const res = await fetch(`${apiBase}/api/watchlists`);
    const data = await res.json();
    setWatchlists(data);
  };

  useEffect(() => {
    fetchWatchlists();
  }, []);

  const handleCreateWatchlist = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch(`${apiBase}/api/watchlists`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newWatchlistName }),
    });
    setNewWatchlistName("");
    fetchWatchlists();
  };

  const handleActivateWatchlist = async (id: string) => {
    await fetch(`${apiBase}/api/watchlists/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: true }),
    });
    fetchWatchlists();
  };

  const handleDeleteWatchlist = async (id: string) => {
    await fetch(`${apiBase}/api/watchlists/${id}`, {
      method: "DELETE",
    });
    fetchWatchlists();
  };

  const handleAddSymbol = async (e: React.FormEvent, watchlistId: string) => {
    e.preventDefault();
    await fetch(`${apiBase}/api/watchlists/${watchlistId}/symbols`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: newSymbol[watchlistId] }),
    });
    setNewSymbol({ ...newSymbol, [watchlistId]: "" });
    fetchWatchlists();
  };

  const handleRemoveSymbol = async (watchlistId: string, symbolId: string) => {
    await fetch(`${apiBase}/api/watchlists/${watchlistId}/symbols/${symbolId}`, {
      method: "DELETE",
    });
    fetchWatchlists();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "2rem" }}>
      <div>
        <h2>Create Watchlist</h2>
        <form onSubmit={handleCreateWatchlist} style={{ display: "flex", gap: "0.5rem" }}>
          <input
            type="text"
            value={newWatchlistName}
            onChange={(e) => setNewWatchlistName(e.target.value)}
            placeholder="New watchlist name"
          />
          <button type="submit">Create</button>
        </form>
      </div>

      <div>
        <h2>Existing Watchlists</h2>
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
          {watchlists.map((wl) => (
            <div key={wl.id} style={{ border: "1px solid #ccc", padding: "1rem" }}>
              <h3>
                {wl.name} {wl.isActive && "(Active)"}
              </h3>
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
                {!wl.isActive && (
                  <button onClick={() => handleActivateWatchlist(wl.id)}>Activate</button>
                )}
                <button onClick={() => handleDeleteWatchlist(wl.id)}>Delete</button>
              </div>
              <div>
                <h4>Symbols</h4>
                <ul>
                  {wl.items.map((item) => (
                    <li key={item.id} style={{ display: "flex", justifyContent: "space-between", width: "200px" }}>
                      {item.symbol.ticker}
                      <button onClick={() => handleRemoveSymbol(wl.id, item.symbol.id)}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
                <form onSubmit={(e) => handleAddSymbol(e, wl.id)} style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
                  <input
                    type="text"
                    value={newSymbol[wl.id] || ""}
                    onChange={(e) => setNewSymbol({ ...newSymbol, [wl.id]: e.target.value })}
                    placeholder="Add symbol"
                  />
                  <button type="submit">Add</button>
                </form>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
