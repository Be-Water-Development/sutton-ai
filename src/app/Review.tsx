"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, FIELDS, UOMS, validateAll, type FieldError } from "@/lib/importer";
import type { Suggestion, WorkRow } from "./types";

type Filter = "all" | "issues" | "fixed" | "ready" | "excluded";
const ENUMS: Record<string, readonly string[]> = { category: CATEGORIES, uom: UOMS, dimension_unit: ["cm", "in"] };
const isBool = (k: string) => k === "is_active" || k === "lot_tracked" || /^vendor_\d_preferred$/.test(k);

export default function Review(props: {
  rows: WorkRow[];
  setRows: (fn: (r: WorkRow[]) => WorkRow[]) => void;
  existing: Set<string>;
  mappedFields: string[];
  aiEnabled: boolean;
  fileName: string;
  onBack: () => void;
  onImport: () => void;
  importing: boolean;
}) {
  const { rows, setRows, existing, aiEnabled } = props;
  const [filter, setFilter] = useState<Filter>("issues");
  const [issueFilter, setIssueFilter] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: number; field: string } | null>(null);
  const [bulk, setBulk] = useState<{ field: string; from: string; to: string; ids: number[] } | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [showAllCols, setShowAllCols] = useState(false);

  const skip = useMemo(() => new Set(rows.map((r, i) => (r.excluded ? i : -1)).filter((i) => i >= 0)), [rows]);
  const errors = useMemo(() => validateAll(rows.map((r) => r.row), existing, skip), [rows, existing, skip]);
  const errOf = (i: number): FieldError[] => (rows[i].excluded ? [] : errors[i]);

  const counts = useMemo(() => {
    let ready = 0, issues = 0, fixed = 0, excluded = 0;
    rows.forEach((r, i) => {
      if (r.excluded) return void excluded++;
      if (errors[i].length) issues++;
      else ready++;
      if (r.autoChanges.length) fixed++;
    });
    return { ready, issues, fixed, excluded, all: rows.length };
  }, [rows, errors]);

  // Group issues so the admin can tackle "the same problem in 12 rows" at once.
  const issueGroups = useMemo(() => {
    const g = new Map<string, { field: string; label: string; ids: number[] }>();
    rows.forEach((r, i) => {
      if (r.excluded) return;
      for (const e of errors[i]) {
        const label = e.message.replace(/“[^”]*”/g, "…").replace(/SKU [A-Z0-9-]+ /, "SKU ").replace(/\(rows [^)]*\)/, "").replace(/appears \d+ times/, "is duplicated");
        const key = `${e.field}|${label}`;
        const cur = g.get(key) ?? { field: e.field, label, ids: [] };
        if (!cur.ids.includes(r.id)) cur.ids.push(r.id);
        g.set(key, cur);
      }
    });
    return [...g.entries()].sort((a, b) => b[1].ids.length - a[1].ids.length);
  }, [rows, errors]);

  const visible = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => {
      if (issueFilter) return (issueGroups.find(([k]) => k === issueFilter)?.[1].ids ?? []).includes(r.id);
      if (filter === "excluded") return r.excluded;
      if (r.excluded) return filter === "all";
      if (filter === "issues") return errors[i].length > 0;
      if (filter === "fixed") return r.autoChanges.length > 0 || Object.keys(r.edited).length > 0;
      if (filter === "ready") return errors[i].length === 0;
      return true;
    });

  // Columns: always the core set; other mapped columns only when "show all" or they carry issues/fixes in view.
  const core = ["sku", "name", "category", "uom", "unit_cost", "quantity_on_hand"];
  const columns = FIELDS.map((f) => f.key).filter((k) => {
    if (!props.mappedFields.includes(k) && !core.includes(k)) return false;
    if (showAllCols || core.includes(k)) return true;
    return visible.some(({ r, i }) => errOf(i).some((e) => e.field === k) || r.autoChanges.some((c) => c.field === k) || k in r.edited);
  });

  function commitEdit(id: number, field: string, value: string) {
    setEditing(null);
    const target = rows.find((r) => r.id === id)!;
    const old = target.row[field] ?? "";
    if (old === value) return;
    setRows((rs) =>
      rs.map((r) => (r.id === id ? { ...r, row: { ...r.row, [field]: value }, edited: { [field]: r.edited[field] ?? old, ...r.edited } } : r)),
    );
    setSuggestions((s) => s.filter((x) => !(x.id === id && x.field === field)));
    // Offer to apply the same fix to other rows with the same bad value.
    const idx = rows.findIndex((r) => r.id === id);
    if (errors[idx].some((e) => e.field === field) && old !== "") {
      const ids = rows.filter((r, i) => r.id !== id && !r.excluded && (r.row[field] ?? "") === old && errors[i].some((e) => e.field === field)).map((r) => r.id);
      if (ids.length) setBulk({ field, from: old, to: value, ids });
    }
  }

  function applyBulk() {
    if (!bulk) return;
    setRows((rs) =>
      rs.map((r) => (bulk.ids.includes(r.id) ? { ...r, row: { ...r.row, [bulk.field]: bulk.to }, edited: { [bulk.field]: r.row[bulk.field] ?? "", ...r.edited } } : r)),
    );
    setBulk(null);
  }

  const toggleExclude = (id: number) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, excluded: !r.excluded } : r)));

  function revertField(id: number, field: string) {
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const edited = { ...r.edited };
        const val = field in edited ? edited[field] : r.original[field] ?? "";
        delete edited[field];
        const autoChanges = field in r.edited ? r.autoChanges : r.autoChanges.filter((c) => c.field !== field);
        return { ...r, row: { ...r.row, [field]: val }, edited, autoChanges };
      }),
    );
  }

  async function askAi() {
    setAiBusy(true);
    setAiError(null);
    try {
      const bad = rows
        .map((r, i) => ({ id: r.id, row: r.row, errors: errOf(i) }))
        .filter((x) => x.errors.length && !suggestions.some((s) => s.id === x.id));
      const res = await fetch("/api/ai/fix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: bad }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const valid = (data.suggestions as Suggestion[]).filter((s) => rows.some((r) => r.id === s.id) && (rows.find((r) => r.id === s.id)!.row[s.field] ?? "") !== s.value);
      setSuggestions((s) => [...s, ...valid]);
      if (!valid.length) setAiError("AI didn't find any fixes it was confident about — the remaining issues need your input.");
      setFilter("issues");
    } catch (e) {
      setAiError(String(e instanceof Error ? e.message : e));
    } finally {
      setAiBusy(false);
    }
  }

  function acceptSuggestion(s: Suggestion) {
    commitEdit(s.id, s.field, s.value);
  }
  function acceptAllSuggestions() {
    setRows((rs) =>
      rs.map((r) => {
        const mine = suggestions.filter((s) => s.id === r.id);
        if (!mine.length) return r;
        const row = { ...r.row };
        const edited = { ...r.edited };
        for (const s of mine) {
          if (!(s.field in edited)) edited[s.field] = row[s.field] ?? "";
          row[s.field] = s.value;
        }
        return { ...r, row, edited };
      }),
    );
    setSuggestions([]);
  }

  const toImport = counts.ready;

  return (
    <div className="flex flex-col gap-4 pb-28">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Ready to import" value={counts.ready} tone="green" active={filter === "ready" && !issueFilter} onClick={() => { setIssueFilter(null); setFilter("ready"); }} />
        <Stat label="Need attention" value={counts.issues} tone={counts.issues ? "red" : "green"} active={filter === "issues" && !issueFilter} onClick={() => { setIssueFilter(null); setFilter("issues"); }} />
        <Stat label="Auto-fixed / edited" value={rows.filter((r) => r.autoChanges.length || Object.keys(r.edited).length).length} tone="amber" active={filter === "fixed" && !issueFilter} onClick={() => { setIssueFilter(null); setFilter("fixed"); }} />
        <Stat label="Excluded" value={counts.excluded} tone="slate" active={filter === "excluded" && !issueFilter} onClick={() => { setIssueFilter(null); setFilter("excluded"); }} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
        {/* Issue groups */}
        <aside className="flex flex-col gap-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-800">Issues by type</h3>
              {issueFilter && (
                <button className="text-xs text-indigo-600 hover:underline" onClick={() => setIssueFilter(null)}>
                  Clear
                </button>
              )}
            </div>
            {issueGroups.length === 0 ? (
              <p className="text-sm text-emerald-700">🎉 No issues left. Everything included is ready to import.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {issueGroups.map(([key, g]) => (
                  <li key={key}>
                    <button
                      onClick={() => setIssueFilter(issueFilter === key ? null : key)}
                      className={`w-full rounded-lg px-2 py-1.5 text-left text-xs transition ${issueFilter === key ? "bg-rose-100 text-rose-900" : "hover:bg-slate-100 text-slate-700"}`}
                    >
                      <span className="mr-1 inline-block min-w-6 rounded bg-rose-500 px-1.5 text-center font-semibold text-white">{g.ids.length}</span>
                      {g.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-3">
            <h3 className="text-sm font-semibold text-indigo-900">✨ AI assist</h3>
            <p className="mt-1 text-xs text-indigo-800">
              Proposes fixes for remaining rows (e.g. inferring a category from the item name). Nothing changes until you accept.
            </p>
            <button
              disabled={!aiEnabled || aiBusy || counts.issues === 0}
              onClick={askAi}
              className="mt-2 w-full rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
            >
              {aiBusy ? "Thinking…" : `Suggest fixes for ${counts.issues} rows`}
            </button>
            {!aiEnabled && <p className="mt-1 text-xs text-indigo-700">Set OPENROUTER_API_KEY to enable.</p>}
            {aiError && <p className="mt-2 text-xs text-rose-700">{aiError}</p>}
            {suggestions.length > 0 && (
              <button onClick={acceptAllSuggestions} className="mt-2 w-full rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100">
                Accept all {suggestions.length} suggestions
              </button>
            )}
          </div>
          <p className="px-1 text-xs text-slate-500">
            Tip: click any cell to edit. Fixing one value offers to fix every row with the same problem.
          </p>
        </aside>

        {/* Grid */}
        <div className="min-w-0 rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 p-2">
            {(["issues", "ready", "fixed", "excluded", "all"] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => { setIssueFilter(null); setFilter(f); }}
                className={`rounded-full px-3 py-1 text-xs font-medium ${filter === f && !issueFilter ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}
              >
                {{ issues: "Needs attention", ready: "Ready", fixed: "Changed", excluded: "Excluded", all: "All rows" }[f]}
              </button>
            ))}
            <span className="ml-auto text-xs text-slate-500">{visible.length} rows shown</span>
            <label className="flex items-center gap-1 text-xs text-slate-600">
              <input type="checkbox" checked={showAllCols} onChange={(e) => setShowAllCols(e.target.checked)} /> All columns
            </label>
          </div>
          <div className="max-h-[62vh] overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-20 bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="sticky left-0 z-30 border-b border-slate-200 bg-slate-50 px-2 py-2">Row</th>
                  {columns.map((c) => (
                    <th key={c} className="whitespace-nowrap border-b border-slate-200 px-2 py-2 font-medium">
                      {FIELDS.find((f) => f.key === c)?.label}
                      {FIELDS.find((f) => f.key === c)?.required && <span className="text-rose-500">*</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 1} className="p-10 text-center text-slate-500">
                      Nothing here. {filter === "issues" ? "All rows are clean 🎉" : ""}
                    </td>
                  </tr>
                )}
                {visible.map(({ r, i }) => {
                  const errs = errOf(i);
                  const rowSugs = suggestions.filter((s) => s.id === r.id);
                  return (
                    <tr key={r.id} className={r.excluded ? "opacity-40" : ""}>
                      <td className="sticky left-0 z-10 border-b border-slate-100 bg-white px-2 py-1 align-top">
                        <div className="flex items-center gap-1.5">
                          <span title={errs.map((e) => e.message).join("\n") || "Ready"} className={`h-2.5 w-2.5 rounded-full ${r.excluded ? "bg-slate-300" : errs.length ? "bg-rose-500" : "bg-emerald-500"}`} />
                          <span className="w-8 text-xs tabular-nums text-slate-500">{r.id}</span>
                          <button
                            onClick={() => toggleExclude(r.id)}
                            className="rounded px-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                            title={r.excluded ? "Include this row" : "Don't import this row"}
                          >
                            {r.excluded ? "↺" : "✕"}
                          </button>
                        </div>
                      </td>
                      {columns.map((c) => {
                        const e = errs.filter((x) => x.field === c);
                        const auto = r.autoChanges.find((x) => x.field === c);
                        const userEdited = c in r.edited;
                        const sug = rowSugs.find((s) => s.field === c);
                        const isEditing = editing?.id === r.id && editing.field === c;
                        const val = r.row[c] ?? "";
                        const tone = e.length ? "bg-rose-50 ring-1 ring-inset ring-rose-300" : userEdited ? "bg-sky-50" : auto ? "bg-amber-50" : "";
                        return (
                          <td key={c} className={`relative border-b border-slate-100 px-1 py-1 align-top ${tone}`}>
                            {isEditing ? (
                              <CellEditor field={c} value={val} onDone={(v) => (v === null ? setEditing(null) : commitEdit(r.id, c, v))} />
                            ) : (
                              <button
                                onClick={() => !r.excluded && setEditing({ id: r.id, field: c })}
                                className="group block w-full min-w-[90px] max-w-[260px] truncate rounded px-1 py-0.5 text-left hover:bg-slate-100"
                                title={[
                                  ...e.map((x) => "⚠ " + x.message),
                                  auto ? `Auto-fixed: “${auto.from}” → “${auto.to}” (${auto.reason})` : "",
                                  userEdited ? `You changed this from “${r.edited[c]}”` : "",
                                ].filter(Boolean).join("\n") || val}
                              >
                                {val === "" ? <span className="text-slate-300">—</span> : val}
                              </button>
                            )}
                            {e.length > 0 && !isEditing && <div className="px-1 text-[11px] leading-tight text-rose-700">{e[0].message}</div>}
                            {(auto || userEdited) && !e.length && !isEditing && (
                              <div className="flex items-center gap-1 px-1 text-[11px] leading-tight text-slate-500">
                                <span className="truncate line-through decoration-slate-400">{userEdited ? r.edited[c] || "empty" : auto!.from || "empty"}</span>
                                <button className="text-indigo-600 hover:underline" onClick={() => revertField(r.id, c)}>
                                  undo
                                </button>
                              </div>
                            )}
                            {sug && (
                              <div className="mt-1 rounded-md border border-indigo-200 bg-indigo-50 p-1 text-[11px] text-indigo-900">
                                <div>
                                  ✨ <b>{sug.value}</b> <span className="text-indigo-600">({sug.confidence})</span>
                                </div>
                                <div className="text-indigo-700">{sug.reason}</div>
                                <div className="mt-0.5 flex gap-2">
                                  <button className="font-semibold text-indigo-700 hover:underline" onClick={() => acceptSuggestion(sug)}>
                                    Accept
                                  </button>
                                  <button className="text-slate-500 hover:underline" onClick={() => setSuggestions((s) => s.filter((x) => x !== sug))}>
                                    Dismiss
                                  </button>
                                </div>
                              </div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {bulk && (
        <div className="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-2xl">
          <span>
            {bulk.ids.length} other row{bulk.ids.length > 1 ? "s have" : " has"} “{bulk.from}” in {FIELDS.find((f) => f.key === bulk.field)?.label}. Change them to “{bulk.to}” too?
          </span>
          <button onClick={applyBulk} className="rounded-lg bg-emerald-500 px-3 py-1 font-semibold hover:bg-emerald-400">
            Fix all {bulk.ids.length}
          </button>
          <button onClick={() => setBulk(null)} className="text-slate-300 hover:text-white">
            No thanks
          </button>
        </div>
      )}

      {/* Sticky footer: exactly what will happen */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-6 py-4">
          <button onClick={props.onBack} className="text-sm text-slate-600 hover:text-slate-900">
            ← Mapping
          </button>
          <div className="text-sm text-slate-700">
            <b className="text-emerald-700">{toImport}</b> of {rows.length} rows will be imported.
            {counts.issues > 0 && <> <b className="text-rose-700">{counts.issues}</b> with issues will be skipped (you'll get them back as a CSV).</>}
            {counts.excluded > 0 && <> {counts.excluded} excluded by you.</>}
          </div>
          <button
            disabled={toImport === 0 || props.importing}
            onClick={props.onImport}
            className="ml-auto rounded-lg bg-emerald-600 px-5 py-2.5 font-semibold text-white shadow hover:bg-emerald-700 disabled:opacity-40"
          >
            {props.importing ? "Importing…" : `Import ${toImport} item${toImport === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Stat(p: { label: string; value: number; tone: "green" | "red" | "amber" | "slate"; active: boolean; onClick: () => void }) {
  const tones = {
    green: "text-emerald-700",
    red: "text-rose-700",
    amber: "text-amber-700",
    slate: "text-slate-600",
  };
  return (
    <button onClick={p.onClick} className={`rounded-xl border bg-white p-3 text-left transition hover:shadow ${p.active ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200"}`}>
      <div className={`text-2xl font-bold tabular-nums ${tones[p.tone]}`}>{p.value}</div>
      <div className="text-xs text-slate-500">{p.label}</div>
    </button>
  );
}

function CellEditor({ field, value, onDone }: { field: string; value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const options = ENUMS[field] ?? (isBool(field) ? ["true", "false"] : null);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") onDone(v);
    if (e.key === "Escape") onDone(null);
  };
  if (options)
    return (
      <select ref={ref} value={options.includes(v) ? v : ""} onChange={(e) => onDone(e.target.value)} onBlur={() => onDone(null)} onKeyDown={key} className="w-full rounded border border-indigo-400 px-1 py-0.5 text-sm">
        <option value="">{v && !options.includes(v) ? `(${v})` : "— choose —"}</option>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  return <input ref={ref} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onDone(v)} onKeyDown={key} className="w-full min-w-[120px] rounded border border-indigo-400 px-1 py-0.5 text-sm" />;
}
