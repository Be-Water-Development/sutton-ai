"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORIES, FIELDS, UOMS, validateAll, validateRow, type FieldError } from "@/lib/importer";
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
  const [aiRan, setAiRan] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [fullRow, setFullRow] = useState<number | null>(null);

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

  // Step 2 works through one line per problem cell. Snapshot on entry so solved problems stay in
  // place (marked solved) instead of jumping out from under the cursor.
  const [fixKeys, setFixKeys] = useState<string[]>([]);
  const currentKeys = () => rows.flatMap((r, i) => (r.excluded ? [] : [...new Set(errors[i].map((e) => `${r.id}|${e.field}`))]));
  useEffect(() => {
    if (phase === "fix") setFixKeys(currentKeys());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  const rowIndex = new Map(rows.map((r, i) => [r.id, i]));
  const problems = [...new Set([...fixKeys, ...currentKeys()])]
    .map((k) => {
      const [idStr, field] = k.split("|");
      const id = Number(idStr);
      const i = rowIndex.get(id);
      if (i === undefined) return null;
      const r = rows[i];
      const msgs = r.excluded ? [] : errors[i].filter((e) => e.field === field).map((e) => e.message);
      return { key: k, id, i, r, field, msgs, solved: r.excluded || msgs.length === 0 };
    })
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => a.id - b.id || FIELDS.findIndex((f) => f.key === a.field) - FIELDS.findIndex((f) => f.key === b.field));
  const solvedCount = problems.filter((p) => p.solved).length;

  function nextProblem(id: number, field: string) {
    const open = problems.filter((p) => !p.solved && !(p.id === id && p.field === field));
    if (!open.length) return null;
    const pos = problems.findIndex((p) => p.id === id && p.field === field);
    const after = open.find((p) => problems.indexOf(p) > pos) ?? open[0];
    return { id: after.id, field: after.field };
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

  const toggleExclude = (id: number) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, excluded: !r.excluded } : r)));

  function revertField(id: number, field: string) {
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const edited = { ...r.edited };
        const val = field in edited ? edited[field] : r.original[field] ?? "";
        delete edited[field];
        // Keep reverted auto-fixes in the list (marked) so the admin can see and redo them.
        const autoChanges = field in r.edited ? r.autoChanges : r.autoChanges.map((c) => (c.field === field ? { ...c, reverted: true } : c));
        return { ...r, row: { ...r.row, [field]: val }, edited, autoChanges };
      }),
    );
  }

  function redoAutoFix(id: number, field: string) {
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        const c = r.autoChanges.find((x) => x.field === field);
        if (!c) return r;
        return { ...r, row: { ...r.row, [field]: c.to }, autoChanges: r.autoChanges.map((x) => (x.field === field ? { ...x, reverted: false } : x)) };
      }),
    );
  }
  const activeFixes = (r: WorkRow) => r.autoChanges.filter((c) => !c.reverted).length;

  async function askAi() {
    setAiBusy(true);
    setAiRan(true);
    setAiError(null);
    try {
      // Every click sends all unsolved rows (in batches of 40, in parallel) and replaces previous suggestions.
      const bad = rows.map((r, i) => ({ id: r.id, row: r.row, errors: errOf(i) })).filter((x) => x.errors.length);
      const batches = Array.from({ length: Math.ceil(bad.length / 40) }, (_, k) => bad.slice(k * 40, k * 40 + 40));
      const results = await Promise.all(
        batches.map(async (b) => {
          const res = await fetch("/api/ai/fix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rows: b }) });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          return data.suggestions as Suggestion[];
        }),
      );
      // Only show suggestions that actually clear the problem on that field.
      const valid = results.flat().filter((s) => {
        const r = rows.find((x) => x.id === s.id);
        if (!r || (r.row[s.field] ?? "") === s.value) return false;
        return !validateRow({ ...r.row, [s.field]: s.value }).some((e) => e.field === s.field);
      });
      setSuggestions(valid);
      setAiRan(true);
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
  const cleanedReady = readyRows.filter((r) => activeFixes(r) > 0 && !Object.keys(r.edited).length).length;

  return (
    <div className="flex flex-col gap-4 pb-28">
      <ReadyMeter ready={counts.ready} total={counts.all} issues={counts.issues} excluded={counts.excluded} />

      {/* ---------- Step 1: what we cleaned up ---------- */}
      {phase === "clean" && (
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 p-4">
            <h2 className="text-lg font-semibold">Step 1 · We cleaned up {cleaned.length} row{cleaned.length === 1 ? "" : "s"} for you</h2>
            <p className="text-sm text-slate-600">
              Formatting fixes we're certain about ({cleaned.reduce((n, r) => n + r.autoChanges.length, 0)} values). Nothing has been saved yet. If a fix looks wrong, “Keep original” puts your value back — the row then shows up in the next step if it still breaks a rule.
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
                      <tr key={`${r.id}-${c.field}`} className={`${j === 0 ? "border-t border-slate-200" : ""} ${c.reverted ? "bg-slate-50 text-slate-400" : ""}`}>
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
                          <code className="whitespace-pre rounded bg-rose-50 px-1.5 py-0.5 text-rose-800">{c.from === "" ? "(empty)" : <ShowSpaces s={c.from} />}</code>
                        </td>
                        <td className="px-3 py-1.5">
                          <code className={`rounded px-1.5 py-0.5 ${c.reverted ? "bg-slate-100 text-slate-400 line-through" : "bg-emerald-50 text-emerald-800"}`}>{c.to}</code>
                        </td>
                        <td className="px-3 py-1.5 text-xs text-slate-500">{c.reverted ? "You kept the original value" : c.reason}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right">
                          {c.reverted ? (
                            <button onClick={() => redoAutoFix(r.id, c.field)} className="text-xs text-indigo-600 hover:underline">
                              Use cleaned value
                            </button>
                          ) : (
                            <button onClick={() => revertField(r.id, c.field)} className="text-xs text-indigo-600 hover:underline">
                              Keep original
                            </button>
                          )}
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
        <section className="rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-start gap-3 border-b border-slate-200 p-4">
            <div>
              <h2 className="text-lg font-semibold">
                Step 2 · Fix {problems.length} problem{problems.length === 1 ? "" : "s"}
              </h2>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <button
                disabled={!aiEnabled || aiBusy || counts.issues === 0}
                onClick={askAi}
                title={aiEnabled ? "AI proposes fixes (e.g. category from the item name). Nothing changes until you accept." : "Set OPENROUTER_API_KEY to enable"}
                className="rounded-lg bg-slate-900 px-3 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {aiBusy ? "✨ Thinking…" : "✨ Suggest fixes"}
              </button>
              {suggestions.length > 0 && (
                <button onClick={acceptAllSuggestions} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100">
                  Accept all {suggestions.length}
                </button>
              )}
            </div>
          </div>
          <div className="mx-4 mt-3 flex gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
            <span className="text-lg leading-none">💡</span>
            <ul className="space-y-1">
              <li><b>Click a red value</b> to edit it. Press <kbd className="rounded border border-slate-300 bg-white px-1 text-xs">Enter</kbd> to save and jump to the next one.</li>
              <li><b>✨ Suggest fixes</b> has AI propose values — nothing changes until you accept.</li>
              <li><b>See full row</b> for context, or <b>Exclude row</b> to leave it out.</li>
              <li>Anything left unfixed is skipped, and you'll get it back as a CSV.</li>
            </ul>
          </div>
          {aiError && <p className="border-b border-slate-100 px-4 py-2 text-xs text-rose-700">{aiError}</p>}
          <div className="px-4 py-2 text-xs text-slate-600">
            <b className="text-emerald-700">{solvedCount}</b> of {problems.length} solved
          </div>
          <div className="max-h-[58vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-left text-xs text-slate-500">
                <tr>
                  <th className="w-16 px-4 py-2">Row</th>
                  <th className="w-40 px-2 py-2">Field</th>
                  <th className="w-64 px-2 py-2">Original value</th>
                  <th className="px-2 py-2">Problem</th>
                  {aiRan && (
                    <>
                      <th className="w-48 px-2 py-2">✨ Proposed value</th>
                      <th className="w-56 px-2 py-2">Reason</th>
                      <th className="w-36 px-2 py-2"></th>
                    </>
                  )}
                  <th className="w-48 px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {problems.length === 0 && (
                  <tr>
                    <td colSpan={aiRan ? 8 : 5} className="p-10 text-center text-emerald-700">🎉 Nothing left to fix.</td>
                  </tr>
                )}
                {problems.map((p) => {
                  const val = p.r.row[p.field] ?? "";
                  const isEditing = editing?.id === p.id && editing.field === p.field;
                  const sug = suggestions.find((s) => s.id === p.id && s.field === p.field);
                  return (
                    <tr key={p.key} className={`border-t border-slate-100 align-top ${p.solved ? "bg-emerald-50/60" : ""}`}>
                      <td className="px-4 py-2 tabular-nums text-slate-500">{p.id}</td>
                      <td className="px-2 py-2 text-slate-700">{label(p.field)}</td>
                      <td className="px-2 py-1.5">
                        {isEditing ? (
                          <CellEditor field={p.field} value={val} onDone={(v, adv) => (v === null ? setEditing(null) : commitEdit(p.id, p.field, v, adv))} />
                        ) : (
                          <button
                            disabled={p.r.excluded}
                            onClick={() => setEditing({ id: p.id, field: p.field })}
                            className={`block w-full truncate rounded border px-2 py-1 text-left ${p.solved ? "border-transparent" : "border-rose-300 bg-rose-50 hover:border-rose-500"}`}
                          >
                            {val === "" ? <span className="text-slate-400">(empty)</span> : val}
                          </button>
                        )}
                      </td>
                      <td className="px-2 py-2">
                        {p.r.excluded ? (
                          <span className="text-slate-500">Row excluded — won't be imported</span>
                        ) : p.solved ? (
                          <span className="font-medium text-emerald-700">✓ Solved{p.field in p.r.edited ? ` (was “${p.r.edited[p.field] || "empty"}”)` : ""}</span>
                        ) : (
                          <span className="text-rose-700">{p.msgs.join("; ")}</span>
                        )}
                      </td>
                      {aiRan &&
                        (sug && !p.solved ? (
                          <>
                            <td className="px-2 py-1.5">
                              <div className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-emerald-900">{sug.value === "" ? "(empty)" : sug.value}</div>
                            </td>
                            <td className="px-2 py-2 text-xs text-slate-600">{sug.reason}</td>
                            <td className="whitespace-nowrap px-2 py-1.5">
                              <button onClick={() => commitEdit(sug.id, sug.field, sug.value)} className="rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-700">
                                Accept
                              </button>
                              <button onClick={() => setSuggestions((s) => s.filter((x) => x !== sug))} className="ml-2 text-xs text-slate-500 hover:text-slate-900 hover:underline">
                                Dismiss
                              </button>
                            </td>
                          </>
                        ) : (
                          <td colSpan={3} className="px-2 py-2 text-xs text-slate-400">
                            {aiBusy && !p.solved ? <span className="inline-block h-4 w-40 animate-pulse rounded bg-slate-200" /> : p.solved ? "" : "—"}
                          </td>
                        ))}
                      <td className="whitespace-nowrap px-4 py-2 text-right text-xs">
                        <button onClick={() => setFullRow(p.id)} className="rounded-md border border-slate-300 px-2 py-1 text-slate-700 hover:bg-slate-100">
                          See full row
                        </button>
                        <button onClick={() => toggleExclude(p.id)} className="ml-2 text-slate-500 hover:text-slate-900 hover:underline">
                          {p.r.excluded ? "Include row" : "Exclude row"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {fullRow !== null && rowIndex.has(fullRow) && (
        <FullRowModal
          row={rows[rowIndex.get(fullRow)!]}
          errors={errOf(rowIndex.get(fullRow)!)}
          fields={FIELDS.map((f) => f.key).filter((k) => props.mappedFields.includes(k) || ["sku", "name", "category", "uom", "unit_cost"].includes(k))}
          onChange={(field, v) => commitEdit(fullRow, field, v)}
          onExclude={() => { toggleExclude(fullRow); setFullRow(null); }}
          onClose={() => setFullRow(null)}
        />
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
                      {Object.keys(r.edited).length > 0 ? <span className="text-sky-700">fixed by you</span> : activeFixes(r) > 0 ? <span className="text-amber-700">cleaned up</span> : ""}
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
              <button onClick={() => setPhase(fixKeys.length || counts.issues ? "fix" : "clean")} className="text-sm text-slate-600 hover:text-slate-900">← Back</button>
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

/** Whole row in context, every field editable, problems highlighted. */
function FullRowModal(p: { row: WorkRow; errors: FieldError[]; fields: string[]; onChange: (field: string, v: string) => void; onExclude: () => void; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && p.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);
  const groups = [...new Set(FIELDS.filter((f) => p.fields.includes(f.key)).map((f) => f.group))];
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 p-4" onMouseDown={p.onClose}>
      <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="sticky top-0 flex items-center gap-3 border-b border-slate-200 bg-white px-5 py-3">
          <div>
            <div className="text-xs text-slate-500">Row {p.row.id}</div>
            <div className="font-semibold">{p.row.row.name || "(no name)"} <span className="font-mono text-sm text-slate-500">{p.row.row.sku}</span></div>
          </div>
          <span className={`ml-2 rounded-full px-2 py-0.5 text-xs ${p.errors.length ? "bg-rose-100 text-rose-800" : "bg-emerald-100 text-emerald-800"}`}>
            {p.errors.length ? `${p.errors.length} problem${p.errors.length > 1 ? "s" : ""}` : "Ready to import"}
          </span>
          <button onClick={p.onClose} className="ml-auto rounded-md px-2 py-1 text-slate-500 hover:bg-slate-100">✕</button>
        </div>
        <div className="space-y-4 px-5 py-4">
          {groups.map((g) => (
            <div key={g}>
              <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{g}</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {FIELDS.filter((f) => f.group === g && p.fields.includes(f.key)).map((f) => {
                  const errs = p.errors.filter((e) => e.field === f.key);
                  return (
                    <label key={f.key} className="block text-sm">
                      <span className="text-xs text-slate-500">{f.label}{f.required && <span className="text-rose-500">*</span>}</span>
                      <FieldInput field={f.key} value={p.row.row[f.key] ?? ""} bad={errs.length > 0} onCommit={(v) => p.onChange(f.key, v)} />
                      {errs.map((e) => <span key={e.message} className="block text-xs text-rose-700">{e.message}</span>)}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
        <div className="sticky bottom-0 flex items-center gap-3 border-t border-slate-200 bg-white px-5 py-3">
          <button onClick={p.onExclude} className="text-sm text-slate-600 hover:underline">{p.row.excluded ? "Include this row" : "Exclude this row"}</button>
          <button onClick={p.onClose} className="ml-auto rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700">Done</button>
        </div>
      </div>
    </div>
  );
}

function FieldInput({ field, value, bad, onCommit }: { field: string; value: string; bad: boolean; onCommit: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const options = ENUMS[field] ?? (isBool(field) ? ["true", "false"] : null);
  const cls = `mt-0.5 w-full rounded-md border px-2 py-1 text-sm ${bad ? "border-rose-400 bg-rose-50" : "border-slate-300"}`;
  if (options)
    return (
      <select value={options.includes(v) ? v : ""} onChange={(e) => { setV(e.target.value); onCommit(e.target.value); }} className={cls}>
        <option value="">{v && !options.includes(v) ? `(${v})` : "—"}</option>
        {options.map((o) => <option key={o}>{o}</option>)}
      </select>
    );
  return <input value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onCommit(v)} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} className={cls} />;
}

/** Make leading/trailing spaces visible as faint dots so whitespace fixes are obvious. */
function ShowSpaces({ s }: { s: string }) {
  const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  const dots = (w: string) => (w ? <span className="text-rose-300">{"·".repeat(w.length)}</span> : null);
  return (
    <>
      {dots(m[1])}
      {m[2]}
      {dots(m[3])}
    </>
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
