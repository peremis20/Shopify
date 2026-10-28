"use client";

import { useMemo, useState } from "react";

/**
 * Click-to-sort for tables. The first click sorts text A to Z and numbers
 * from high to low; clicking the same column again flips the order.
 * Empty values always go last.
 */

export type SortValue = string | number | null | undefined;
export type SortDir = "asc" | "desc";

export interface SortState {
  key: string;
  dir: SortDir;
  toggle: (key: string) => void;
}

export function useSort<T>(
  rows: T[],
  columns: Record<string, (row: T) => SortValue>,
  initial: { key: string; dir: SortDir }
): { sorted: T[]; sort: SortState } {
  const [key, setKey] = useState(initial.key);
  const [dir, setDir] = useState<SortDir>(initial.dir);

  const sorted = useMemo(() => {
    const get = columns[key];
    if (!get) return rows;
    const factor = dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
      if (y === null || y === undefined) return -1;
      if (typeof x === "number" && typeof y === "number") return (x - y) * factor;
      return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: "base" }) * factor;
    });
    // columns is rebuilt every render; the getters only depend on the row
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, key, dir]);

  function toggle(next: string) {
    if (next === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    const sample = rows.map(columns[next]).find((v) => v !== null && v !== undefined);
    setKey(next);
    setDir(typeof sample === "number" ? "desc" : "asc");
  }

  return { sorted, sort: { key, dir, toggle } };
}

/** A column header button that shows and changes the sort. */
export function SortHeader({ label, column, sort, align = "left" }: {
  label: string;
  column: string;
  sort: SortState;
  align?: "left" | "right";
}) {
  const active = sort.key === column;
  return (
    <button
      type="button"
      onClick={() => sort.toggle(column)}
      className={`inline-flex items-center gap-1 font-semibold hover:text-dash-green ${active ? "text-dash-green" : ""} ${
        align === "right" ? "flex-row-reverse" : ""
      }`}
      aria-label={`Sort by ${label}`}
      title={active ? `Sorted ${sort.dir === "asc" ? "low to high, A to Z" : "high to low, Z to A"}. Click to flip.` : `Sort by ${label}`}
    >
      {label}
      <span className={`text-[10px] ${active ? "" : "opacity-30"}`} aria-hidden="true">
        {active ? (sort.dir === "asc" ? "▲" : "▼") : "▼"}
      </span>
    </button>
  );
}
