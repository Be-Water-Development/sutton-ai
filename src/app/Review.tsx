"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, FIELDS, UOMS, validateAll, type FieldError } from "@/lib/importer";
import type { Suggestion, WorkRow } from "./types";

export type Phase = "clean" | "fix" | "confirm";
const ENUMS: Record<string, readonly string[]> = { category: CATEGORIES, uom: UOMS, dimension_unit: ["cm", "in"] };
const isBool = (k: string) => k === "is_active" || k === "lot_tracked" || /^vendor_\d_preferred$/.test(k);
const label = (k: string) => FIELDS.find((f) => f.key === k)?.label ?? k;

export default function Review(props: {
  phase: Phase;
  setPhase: (p: Phase) => void;
  rows: WorkRow[];
  setRows: (fn: (r: WorkRow[]) => WorkRow[]) => void;
  existing: Set<string>;
  mappedFields: string[];
  aiEnabled: boolean;
  fileName: string;
  onBack: () => void;
  onImport: () => void;
  importing: boolean;
  updateExisting: boolean;
  setUpdateExisting: (v: boolean) => void;
}) {
  const { rows, setRows, existing, aiEnabled, setPhase } = props;
  const phase: Phase = props.phase ?? "clean";
  const [editing, setEditing] = useState<{ id: number; field: string } | null>(null);
  const [bulk, setBulk] = useState<{ field: string; from: string; to: string; ids: number[] } | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  const [asked, setAsked] = useState<Set<number>>(new Set());
  const [aiError, setAiError] = useState<string | null>(null);
  const [showAllCols, setShowAllCols] = useState(false);
  const [hideSolved, setHideSolved] = useState(false);

  const skip = useMemo(() => new Set(rows.map((r, i) => (r.excluded ? i : -1)).filter((i) => i >= 0)), [rows]);
  const errors = useMemo(
    () => validateAll(rows.map((r) => r.row), props.updateExisting ? new Set<string>() : existing, skip),
    [rows, existing, skip, props.updateExisting],
  );
  const errOf = (i: number): FieldError[] => (rows[i].excluded ? [] : errors[i]);

  const counts = useMemo(() => {
    let ready = 0, issues = 0, excluded = 0;
    rows.forEach((r, i) => {
      if (r.excluded) excluded++;
      else if (errors[i].length) issues++;
      else ready++;
    });
    return { ready, issues, excluded, all: rows.length };
  }, [rows, errors]);

  const cleaned = rows.filter((r) => r.autoChanges.length > 0);

  // The rows the admin is working through in step 2. Snapshot on entry so fixed rows stay in place
  // (marked solved) instead of jumping out from under the cursor.
  const [fixIds, setFixIds] = useState<number[]>([]);
  useEffect(() => {
    if (phase === "fix") setFixIds(rows.filter((r, i) => !r.excluded && errors[i].length).map((r) => r.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const fixSet = new Set(fixIds);
  const visible = rows
    .map((r, i) => ({ r, i }))
    .filter(({ r, i }) => {
      const open = !r.excluded && errors[i].length > 0;
      if (!fixSet.has(r.id) && !open) return false;
      if (hideSolved && !open) return false;
      return true;
    });
  const solved = fixIds.filter((id) => {
    const i = rows.findIndex((r) => r.id === id);
    return i >= 0 && (rows[i].excluded || errors[i].length === 0);
  }).length;

  // Issue groups only power the one-click bulk fixes in step 2.
  const issueGroups = useMemo(() => {
    const g = new Map<string, { field: string; label: string; ids: number[] }>();
    rows.forEach((r, i) => {
      if (r.excluded) return;
      for (const e of errors[i]) {
        const l = e.message.replace(/“[^”]*”/g, "…").replace(/SKU [A-Z0-9-]+ /, "SKU ").replace(/\(rows [^)]*\)/, "").replace(/appears \d+ times/, "is duplicated");
        const key = `${e.field}|${l}`;
        const cur = g.get(key) ?? { field: e.field, label: l, ids: [] };
        if (!cur.ids.includes(r.id)) cur.ids.push(r.id);
        g.set(key, cur);
      }
    });
    return [...g.values()];
  }, [rows, errors]);

  const core = ["sku", "name", "category", "uom", "unit_cost", "quantity_on_hand"];
  const columns = FIELDS.map((f) => f.key).filter((k) => {
    if (!props.mappedFields.includes(k) && !core.includes(k)) return false;
    if (showAllCols || core.includes(k)) return true;
    return visible.some(({ r, i }) => errOf(i).some((e) => e.field === k) || k in r.edited || fixSet.has(r.id) && errors[i].some((e) => e.field === k));
  });

  function nextProblem(id: number, field: string) {
    const cells: { id: number; field: string }[] = [];
    for (const { r, i } of visible) for (const c of columns) if (errOf(i).some((e) => e.field === c) && !(r.id === id && c === field)) cells.push({ id: r.id, field: c });
    if (!cells.length) return null;
    const pos = visible.findIndex(({ r }) => r.id === id);
    const colPos = columns.indexOf(field);
    const after = cells.find((c) => {
      const p = visible.findIndex(({ r }) => r.id === c.id);
      return p > pos || (p === pos && columns.indexOf(c.field) > colPos);
    });
    return after ?? cells[0];
  }

  function commitEdit(id: number, field: string, value: string, advance = false) {
    setEditing(advance ? nextProblem(id, field) : null);
    const target = rows.find((r) => r.id === id)!;
    const old = target.row[field] ?? "";
    if (old === value) return;
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, row: { ...r.row, [field]: value }, edited: { [field]: r.edited[field] ?? old, ...r.edited } } : r)));
    setSuggestions((s) => s.filter((x) => !(x.id === id && x.field === field)));
    const idx = rows.findIndex((r) => r.id === id);
    if (field !== "sku" && errors[idx].some((e) => e.field === field) && old !== "") {
      const ids = rows.filter((r, i) => r.id !== id && !r.excluded && (r.row[field] ?? "") === old && errors[i].some((e) => e.field === field)).map((r) => r.id);
      if (ids.length) setBulk({ field, from: old, to: value, ids });
    }
  }

  function applyBulk() {
    if (!bulk) return;
    setRows((rs) => rs.map((r) => (bulk.ids.includes(r.id) ? { ...r, row: { ...r.row, [bulk.field]: bulk.to }, edited: { [bulk.field]: r.row[bulk.field] ?? "", ...r.edited } } : r)));
    setBulk(null);
  }

  function setField(ids: number[], field: string, value: (r: WorkRow) => string) {
    setRows((rs) => rs.map((r) => (ids.includes(r.id) ? { ...r, row: { ...r.row, [field]: value(r) }, edited: { [field]: r.row[field] ?? "", ...r.edited } } : r)));
  }

  // One-click fixes for problems that show up in several rows. The admin decides; we do the typing.
  const quickFixes = useMemo(() => {
    const out: { label: string; run: () => void }[] = [];
    for (const g of issueGroups) {
      if (g.label.includes("Discontinued items must have Active = false"))
        out.push({ label: `Mark ${g.ids.length} discontinued item${g.ids.length > 1 ? "s" : ""} inactive`, run: () => setField(g.ids, "is_active", () => "false") });
      if (g.label.includes("is duplicated in this file")) {
        const seen = new Set<string>();
        const later: number[] = [];
        for (const r of rows) if (g.ids.includes(r.id)) { if (seen.has(r.row.sku)) later.push(r.id); else seen.add(r.row.sku); }
        if (later.length) out.push({ label: `Duplicate SKUs: keep first, exclude ${later.length} later cop${later.length > 1 ? "ies" : "y"}`, run: () => setRows((rs) => rs.map((r) => (later.includes(r.id) ? { ...r, excluded: true } : r))) });
      }
      if (g.label.includes("Only one vendor can be preferred") && g.field === "vendor_1_preferred")
        out.push({
          label: `Multiple preferred vendors: keep the cheapest (${g.ids.length})`,
          run: () =>
            setRows((rs) =>
              rs.map((r) => {
                if (!g.ids.includes(r.id)) return r;
                const pref = [1, 2, 3].filter((n) => r.row[`vendor_${n}_preferred`] === "true");
                if (pref.length < 2) return r;
                const best = pref.reduce((a, b) => (Number(r.row[`vendor_${b}_unit_cost`]) < Number(r.row[`vendor_${a}_unit_cost`]) ? b : a));
                const row = { ...r.row };
                const edited = { ...r.edited };
                for (const n of pref) if (n !== best) { const k = `vendor_${n}_preferred`; if (!(k in edited)) edited[k] = row[k]; row[k] = "false"; }
                return { ...r, row, edited };
              }),
            ),
        });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [issueGroups, rows]);

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
        .filter((x) => x.errors.length && !asked.has(x.id) && !suggestions.some((s) => s.id === x.id))
        .slice(0, 40);
      if (!bad.length) throw new Error("AI has already looked at every remaining row. Edit them directly or exclude them.");
      setAsked((a) => new Set([...a, ...bad.map((b) => b.id)]));
      const res = await fetch("/api/ai/fix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: bad }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const valid = (data.suggestions as Suggestion[]).filter((s) => rows.some((r) => r.id === s.id) && (rows.find((r) => r.id === s.id)!.row[s.field] ?? "") !== s.value);
      setSuggestions((s) => [...s, ...valid]);
      if (!valid.length) setAiError("AI didn't find any fixes it was confident about — the remaining issues need your input.");
    } catch (e) {
      setAiError(String(e instanceof Error ? e.message : e));
    } finally {
      setAiBusy(false);
    }
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

  const existingHits = rows.filter((r) => !r.excluded && existing.has((r.row.sku ?? "").trim())).length;
  const readyRows = rows.filter((r, i) => !r.excluded && errors[i].length === 0);
  const editedReady = readyRows.filter((r) => Object.keys(r.edited).length > 0).length;
  const cleanedReady = readyRows.filter((r) => r.autoChanges.length > 0 && !Object.keys(r.edited).length).length;

  return (
    <div className="flex flex-col gap-4 pb-28">
      <ReadyMeter ready={counts.ready} total={counts.all} issues={counts.issues} excluded={counts.excluded} />

      {/* ---------- Step 1: what we cleaned up ---------- */}
      {phase === "clean" && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 p-4">
            <h2 className="text-lg font-semibold">Step 1 · We cleaned up {cleaned.length} row{cleaned.length === 1 ? "" : "s"} for you</h2>
            <p className="text-sm text-slate-600">
              Formatting fixes we're certain about ({cleaned.reduce((n, r) => n + r.autoChanges.length, 0)} values). Nothing has been saved yet — undo anything that looks wrong.
            </p>
          </div>
          {cleaned.length === 0 ? (
            <p className="p-8 text-center text-slate-500">Your file was already clean — nothing needed fixing.</p>
          ) : (
            <div className="max-h-[60vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Row</th>
                    <th className="px-3 py-2">Item</th>
                    <th className="px-3 py-2">Field</th>
                    <th className="px-3 py-2">Original</th>
                    <th className="px-3 py-2">Cleaned</th>
                    <th className="px-3 py-2">Why</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {cleaned.flatMap((r) =>
                    r.autoChanges.map((c, j) => (
                      <tr key={`${r.id}-${c.field}`} className={j === 0 ? "border-t border-slate-200" : ""}>
                        <td className="px-3 py-1.5 align-top tabular-nums text-slate-500">{j === 0 ? r.id : ""}</td>
                        <td className="px-3 py-1.5 align-top">
                          {j === 0 && (
                            <>
                              <span className="font-mono text-xs">{r.row.sku || "—"}</span> <span className="text-slate-600">{r.row.name}</span>
                            </>
                          )}
                        </td>
                        <td className="px-3 py-1.5 text-slate-600">{label(c.field)}</td>
                        <td className="px-3 py-1.5">
                          <code className="whitespace-pre rounded bg-rose-50 px-1.5 py-0.5 text-rose-800 line-through decoration-rose-300">{c.from === "" ? "(empty)" : JSON.stringify(c.from).slice(1, -1)}</code>
                        </td>
                        <td className="px-3 py-1.5">
                          <code className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-800">{c.to}</code>
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-500">{c.reason}</td>
                        <td className="px-3 py-1.5 text-right">
                          <button onClick={() => revertField(r.id, c.field)} className="text-xs text-indigo-600 hover:underline">
                            undo
                          </button>
                        </td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* ---------- Step 2: fix what's left ---------- */}
      {phase === "fix" && (
        <section className="min-w-0 rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-start gap-3 border-b border-slate-200 p-4">
            <div>
              <h2 className="text-lg font-semibold">
                Step 2 · Fix {fixIds.length} row{fixIds.length === 1 ? "" : "s"} that need attention
              </h2>
              <p className="text-sm text-slate-600">
                Click a red cell to fix it — <kbd className="rounded border px-1 text-xs">Enter</kbd> saves and jumps to the next problem. Or exclude a row with ✕. Anything left unfixed is skipped and handed back to you as a CSV.
              </p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                disabled={!aiEnabled || aiBusy || counts.issues === 0}
                onClick={askAi}
                title={aiEnabled ? "AI proposes fixes (e.g. category from the item name). Nothing changes until you accept." : "Set OPENROUTER_API_KEY to enable"}
                className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-40"
              >
                {aiBusy ? "✨ Thinking…" : `✨ Suggest fixes`}
              </button>
              {suggestions.length > 0 && (
                <button onClick={acceptAllSuggestions} className="rounded-lg border border-indigo-300 bg-white px-3 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50">
                  Accept all {suggestions.length}
                </button>
              )}
            </div>
          </div>
          {aiError && <p className="border-b border-slate-100 px-4 py-2 text-xs text-rose-700">{aiError}</p>}
          {quickFixes.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50 px-4 py-2">
              <span className="text-xs font-medium text-slate-500">Quick fixes:</span>
              {quickFixes.map((q) => (
                <button key={q.label} onClick={q.run} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-800 hover:border-slate-900">
                  {q.label}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center gap-4 px-4 py-2 text-xs text-slate-600">
            <span>
              <b className="text-emerald-700">{solved}</b> of {fixIds.length} solved
            </span>
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={hideSolved} onChange={(e) => setHideSolved(e.target.checked)} /> Hide solved
            </label>
            <label className="ml-auto flex items-center gap-1">
              <input type="checkbox" checked={showAllCols} onChange={(e) => setShowAllCols(e.target.checked)} /> All columns
            </label>
          </div>
          <div className="max-h-[58vh] overflow-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead className="sticky top-0 z-20 bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="sticky left-0 z-30 border-b border-slate-200 bg-slate-50 px-2 py-2">Row</th>
                  {columns.map((c) => (
                    <th key={c} className="whitespace-nowrap border-b border-slate-200 px-2 py-2 font-medium">
                      {label(c)}
                      {FIELDS.find((f) => f.key === c)?.required && <span className="text-rose-500">*</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={columns.length + 1} className="p-10 text-center text-emerald-700">
                      🎉 Nothing left to fix.
                    </td>
                  </tr>
                )}
                {visible.map(({ r, i }) => {
                  const errs = errOf(i);
                  const isSolved = !r.excluded && errs.length === 0;
                  const rowSugs = suggestions.filter((s) => s.id === r.id);
                  return (
                    <tr key={r.id} className={`transition-colors ${r.excluded ? "opacity-40" : isSolved ? "bg-emerald-50/60" : ""}`}>
                      <td className={`sticky left-0 z-10 border-b border-slate-100 px-2 py-1 align-top ${isSolved ? "bg-emerald-50" : "bg-white"}`}>
                        <div className="flex items-center gap-1.5">
                          <span className={`h-2.5 w-2.5 rounded-full ${r.excluded ? "bg-slate-300" : errs.length ? "bg-rose-500" : "bg-emerald-500"}`} />
                          <span className="w-8 text-xs tabular-nums text-slate-500">{r.id}</span>
                          <button onClick={() => toggleExclude(r.id)} className="rounded px-1 text-xs text-slate-400 hover:bg-slate-100 hover:text-slate-700" title={r.excluded ? "Include this row" : "Don't import this row"}>
                            {r.excluded ? "↺" : "✕"}
                          </button>
                        </div>
                        {isSolved && <div className="mt-0.5 text-[10px] font-semibold text-emerald-700">✓ Solved</div>}
                        {r.excluded && <div className="mt-0.5 text-[10px] text-slate-500">Excluded</div>}
                        {errs.length > 0 && (
                          <div className="mt-0.5 flex max-w-[150px] flex-wrap gap-1">
                            {[...new Set(errs.map((e) => e.field))].map((f) => (
                              <button
                                key={f}
                                title={errs.filter((e) => e.field === f).map((e) => e.message).join("\n")}
                                onClick={() => {
                                  if (!columns.includes(f)) setShowAllCols(true);
                                  setEditing({ id: r.id, field: f });
                                }}
                                className="rounded bg-rose-100 px-1 text-[10px] leading-4 text-rose-800 hover:bg-rose-200"
                              >
                                {label(f)}
                              </button>
                            ))}
                          </div>
                        )}
                      </td>
                      {columns.map((c) => {
                        const e = errs.filter((x) => x.field === c);
                        const userEdited = c in r.edited;
                        const sug = rowSugs.find((s) => s.field === c);
                        const isEditing = editing?.id === r.id && editing.field === c;
                        const val = r.row[c] ?? "";
                        const tone = e.length ? "bg-rose-50 ring-1 ring-inset ring-rose-300" : userEdited ? "bg-sky-50" : "";
                        return (
                          <td key={c} className={`relative border-b border-slate-100 px-1 py-1 align-top ${tone}`}>
                            {isEditing ? (
                              <CellEditor field={c} value={val} onDone={(v, adv) => (v === null ? setEditing(null) : commitEdit(r.id, c, v, adv))} />
                            ) : (
                              <button
                                onClick={() => !r.excluded && setEditing({ id: r.id, field: c })}
                                className="block w-full min-w-[90px] max-w-[260px] truncate rounded px-1 py-0.5 text-left hover:bg-slate-100"
                                title={[...e.map((x) => "⚠ " + x.message), userEdited ? `You changed this from “${r.edited[c]}”` : ""].filter(Boolean).join("\n") || val}
                              >
                                {val === "" ? <span className="text-slate-300">—</span> : val}
                              </button>
                            )}
                            {e.length > 0 && !isEditing && <div className="px-1 text-[11px] leading-tight text-rose-700">{e[0].message}</div>}
                            {userEdited && !e.length && !isEditing && (
                              <div className="flex items-center gap-1 px-1 text-[11px] leading-tight text-slate-500">
                                <span className="truncate line-through decoration-slate-400">{r.edited[c] || "empty"}</span>
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
                                  <button className="font-semibold text-indigo-700 hover:underline" onClick={() => commitEdit(sug.id, sug.field, sug.value)}>
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
        </section>
      )}

      {/* ---------- Step 3: confirm ---------- */}
      {phase === "confirm" && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 p-4">
            <h2 className="text-lg font-semibold">Step 3 · Ready to import {counts.ready} item{counts.ready === 1 ? "" : "s"}</h2>
            <ul className="mt-2 grid gap-1 text-sm text-slate-700 sm:grid-cols-2">
              <li>✅ {counts.ready - cleanedReady - editedReady} straight from your file</li>
              <li>🧹 {cleanedReady} cleaned up automatically</li>
              <li>✏️ {editedReady} fixed by you</li>
              {counts.excluded > 0 && <li>🚫 {counts.excluded} excluded by you (not imported)</li>}
              {counts.issues > 0 && (
                <li className="text-rose-700">
                  ⚠️ {counts.issues} still have problems and will be skipped —{" "}
                  <button className="underline" onClick={() => setPhase("fix")}>
                    fix them
                  </button>
                </li>
              )}
            </ul>
            {existingHits > 0 && (
              <label className="mt-3 flex items-center gap-2 rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
                <input type="checkbox" checked={props.updateExisting} onChange={(e) => props.setUpdateExisting(e.target.checked)} />
                {existingHits} SKU{existingHits === 1 ? " is" : "s are"} already in inventory — update {existingHits === 1 ? "it" : "them"} with this file instead of skipping
              </label>
            )}
          </div>
          <div className="max-h-[50vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2">Row</th><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">UoM</th><th className="px-3 py-2 text-right">Unit cost</th><th className="px-3 py-2 text-right">On hand</th><th className="px-3 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {readyRows.map((r) => (
                  <tr key={r.id} className="border-t border-slate-100">
                    <td className="px-3 py-1.5 tabular-nums text-slate-500">{r.id}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.row.sku}</td>
                    <td className="px-3 py-1.5">{r.row.name}</td>
                    <td className="px-3 py-1.5">{r.row.category}</td>
                    <td className="px-3 py-1.5">{r.row.uom}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">${Number(r.row.unit_cost).toFixed(2)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{r.row.quantity_on_hand || 0}</td>
                    <td className="px-3 py-1.5 text-xs">
                      {Object.keys(r.edited).length > 0 ? <span className="text-sky-700">fixed by you</span> : r.autoChanges.length > 0 ? <span className="text-amber-700">cleaned up</span> : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {bulk && (
        <div className="fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-2xl">
          <span>
            {bulk.ids.length} other row{bulk.ids.length > 1 ? "s have" : " has"} “{bulk.from}” in {label(bulk.field)}. Change them to “{bulk.to}” too?
          </span>
          <button onClick={applyBulk} className="rounded-lg bg-emerald-500 px-3 py-1 font-semibold hover:bg-emerald-400">
            Fix all {bulk.ids.length}
          </button>
          <button onClick={() => setBulk(null)} className="text-slate-300 hover:text-white">
            No thanks
          </button>
        </div>
      )}

      {/* Sticky footer: one clear next step */}
      <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-4 px-6 py-4">
          {phase === "clean" && (
            <>
              <button onClick={props.onBack} className="text-sm text-slate-600 hover:text-slate-900">← Match columns</button>
              <span className="text-sm text-slate-600">Looks right? Next, the rows we couldn't fix on our own.</span>
              <button onClick={() => setPhase(counts.issues ? "fix" : "confirm")} className="ml-auto rounded-lg bg-slate-900 px-5 py-2.5 font-semibold text-white hover:bg-slate-700">
                {counts.issues ? `Next: ${counts.issues} need attention →` : "Next: review & import →"}
              </button>
            </>
          )}
          {phase === "fix" && (
            <>
              <button onClick={() => setPhase("clean")} className="text-sm text-slate-600 hover:text-slate-900">← Cleaned up</button>
              <span className="text-sm text-slate-600">
                {counts.issues > 0 ? (
                  <><b className="text-rose-700">{counts.issues}</b> still need attention. You can continue — they'll be skipped and returned as a CSV.</>
                ) : (
                  <span className="text-emerald-700">All problems solved 🎉</span>
                )}
              </span>
              <button
                onClick={() => setPhase("confirm")}
                className={`ml-auto rounded-lg px-5 py-2.5 font-semibold text-white ${counts.issues ? "bg-slate-900 hover:bg-slate-700" : "bg-emerald-600 hover:bg-emerald-700"}`}
              >
                Next: review {counts.ready} ready →
              </button>
            </>
          )}
          {phase === "confirm" && (
            <>
              <button onClick={() => setPhase(fixIds.length || counts.issues ? "fix" : "clean")} className="text-sm text-slate-600 hover:text-slate-900">← Back</button>
              <span className="text-sm text-slate-700">
                <b className="text-emerald-700">{counts.ready}</b> of {counts.all} rows will be imported.
                {counts.issues > 0 && <> {counts.issues} skipped.</>}
                {counts.excluded > 0 && <> {counts.excluded} excluded.</>}
              </span>
              <button
                disabled={counts.ready === 0 || props.importing}
                onClick={props.onImport}
                className="ml-auto rounded-lg bg-emerald-600 px-5 py-2.5 font-semibold text-white shadow hover:bg-emerald-700 disabled:opacity-40"
              >
                {props.importing ? "Importing…" : `Import ${counts.ready} item${counts.ready === 1 ? "" : "s"}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Big "ready to import" counter that counts up (and flashes) as problems get solved. */
function ReadyMeter({ ready, total, issues, excluded }: { ready: number; total: number; issues: number; excluded: number }) {
  const shown = useCountUp(ready);
  const [flash, setFlash] = useState(false);
  const prev = useRef(ready);
  useEffect(() => {
    if (ready > prev.current) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 700);
      prev.current = ready;
      return () => clearTimeout(t);
    }
    prev.current = ready;
  }, [ready]);
  const pct = total ? (ready / total) * 100 : 0;
  const pctBad = total ? (issues / total) * 100 : 0;
  return (
    <div className={`rounded-xl border bg-white p-4 transition-shadow ${flash ? "border-emerald-400 shadow-[0_0_0_4px_rgba(16,185,129,0.15)]" : "border-slate-200"}`}>
      <div className="flex items-baseline gap-3">
        <span className={`text-4xl font-bold tabular-nums text-emerald-700 transition-transform ${flash ? "scale-110" : ""}`}>{shown}</span>
        <span className="text-slate-600">of {total} rows ready to import</span>
        <span className="ml-auto text-sm text-slate-500">
          {issues > 0 && <span className="text-rose-700">{issues} need attention</span>}
          {excluded > 0 && <span> · {excluded} excluded</span>}
        </span>
      </div>
      <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-slate-100">
        <div className="bg-emerald-500 transition-all duration-500" style={{ width: `${pct}%` }} />
        <div className="bg-rose-400 transition-all duration-500" style={{ width: `${pctBad}%` }} />
      </div>
    </div>
  );
}

function useCountUp(target: number) {
  const [v, setV] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 450);
      setV(Math.round(a + (target - a) * (1 - Math.pow(1 - p, 3))));
      if (p < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return v;
}

function CellEditor({ field, value, onDone }: { field: string; value: string; onDone: (v: string | null, advance?: boolean) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, []);
  const options = ENUMS[field] ?? (isBool(field) ? ["true", "false"] : null);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      onDone(v, true);
    }
    if (e.key === "Escape") onDone(null);
  };
  if (options)
    return (
      <select ref={ref} value={options.includes(v) ? v : ""} onChange={(e) => onDone(e.target.value, true)} onBlur={() => onDone(null)} onKeyDown={key} className="w-full rounded border border-indigo-400 px-1 py-0.5 text-sm">
        <option value="">{v && !options.includes(v) ? `(${v})` : "— choose —"}</option>
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  return <input ref={ref} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => onDone(v)} onKeyDown={key} className="w-full min-w-[120px] rounded border border-indigo-400 px-1 py-0.5 text-sm" />;
}
