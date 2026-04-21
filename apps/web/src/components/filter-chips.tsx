"use client";

import type { ChangeEvent } from "react";

export interface FilterOption {
  value: string;
  label: string;
  tone?: "good" | "warn" | "critical" | "info" | "neutral";
}

export interface FilterChipsProps {
  label: string;
  options: FilterOption[];
  selected: string[];
  onChange: (next: string[]) => void;
  /** Show an "All" (clear) chip as the first option. */
  allowClear?: boolean;
}

/**
 * Multi-select chip filter. Clicking a chip toggles it. Clicking "All"
 * clears the selection. Designed to be compact and keyboard-accessible.
 */
export function FilterChips({ label, options, selected, onChange, allowClear = true }: FilterChipsProps) {
  const selectedSet = new Set(selected);
  return (
    <div className="filter-chips" role="group" aria-label={label}>
      <span className="filter-chips-label">{label}</span>
      {allowClear ? (
        <button
          type="button"
          className={`filter-chip ${selected.length === 0 ? "active" : ""}`.trim()}
          onClick={() => onChange([])}
        >
          All
        </button>
      ) : null}
      {options.map((option) => {
        const isOn = selectedSet.has(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className={`filter-chip ${isOn ? "active" : ""} ${option.tone ? `tone-${option.tone}` : ""}`.trim()}
            onClick={() => {
              const next = new Set(selectedSet);
              if (isOn) next.delete(option.value);
              else next.add(option.value);
              onChange(Array.from(next));
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export interface SearchBoxProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}

export function SearchBox({ value, onChange, placeholder, ariaLabel }: SearchBoxProps) {
  return (
    <label className="search-box">
      <span className="visually-hidden">{ariaLabel ?? placeholder ?? "Search"}</span>
      <input
        type="search"
        value={value}
        onChange={(event: ChangeEvent<HTMLInputElement>) => onChange(event.currentTarget.value)}
        placeholder={placeholder ?? "Search…"}
        aria-label={ariaLabel ?? placeholder ?? "Search"}
      />
    </label>
  );
}

export interface GroupingToggleProps {
  label?: string;
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (next: string) => void;
}

export function GroupingToggle({ label = "Group by", options, value, onChange }: GroupingToggleProps) {
  return (
    <label className="grouping-toggle">
      <span className="eyebrow">{label}</span>
      <select value={value} onChange={(event) => onChange(event.currentTarget.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
