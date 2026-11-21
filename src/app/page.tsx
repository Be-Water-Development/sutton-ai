"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import Papa from "papaparse";
import { FIELDS, applyMapping, autofixRow, guessMapping, rowsToCsv, type Item, type RawRow } from "@/lib/importer";
import Review from "./Review";
import type { ImportResult, WorkRow } from "./types";

type Step = "upload" | "map" | "review" | "done";

// Client-only render: browser extensions (e.g. ColorZilla) inject nodes into <body> before
// React hydrates, which causes hydration mismatches. This is a local tool with no SEO needs,
// so we skip SSR for the app shell entirely.
export default function Page() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted ? <Home /> : null;
}

function Home() {
  const [step, setStep] = useState<Step>("upload");
  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [records, setRecords] = useState<RawRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  const [mappingSource, setMappingSource] = useState<Record<string, "auto" | "ai" | "you">>({});
  const [aiReasons, setAiReasons] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<WorkRow[]>([]);
  const [inventory, setInventory] = useState<Item[]>([]);
  const [batches, setBatches] = useState<ImportResult["batch"][]>([]);
  const [config, setConfig] = useState({ aiEnabled: false, model: "" });
  const [result, setResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiMapBusy, setAiMapBusy] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Keep in-progress work across refreshes so an accidental reload never loses the admin's fixes.
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("import-wip") ?? "null");
      if (saved && (saved.step === "map" || saved.step === "review")) {
        setFileName(saved.fileName); setHeaders(saved.headers); setRecords(saved.records); setMapping(saved.mapping);
        setMappingSource(saved.mappingSource ?? {}); setRows(saved.rows ?? []); setStep(saved.step); setRestored(true);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      if (step === "map" || step === "review") localStorage.setItem("import-wip", JSON.stringify({ step, fileName, headers, records, mapping, mappingSource, rows }));
      else localStorage.removeItem("import-wip");
    } catch {}
  }, [step, fileName, headers, records, mapping, mappingSource, rows]);

  const refresh = useCallback(async () => {
    const d = await fetch("/api/items").then((r) => r.json());
    setInventory(d.items);
    setBatches(d.batches ?? []);
  }, []);
  useEffect(() => {
    refresh();
    fetch("/api/config").then((r) => r.json()).then(setConfig);
  }, [refresh]);

  const existing = useMemo(() => new Set(inventory.map((i) => i.sku)), [inventory]);

  function loadText(text: string, name: string) {
    setError(null);
    const parsed = Papa.parse<RawRow>(text.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy" });
    const hs = (parsed.meta.fields ?? []).filter((h) => h.trim() !== "");
    if (!hs.length || !parsed.data.length) {
      setError("That file doesn't look like a CSV with a header row and at least one item.");
      return;
    }
    const m = guessMapping(hs);
    setFileName(name);
    setHeaders(hs);
    setRecords(parsed.data);
    setMapping(m);
    setMappingSource(Object.fromEntries(hs.filter((h) => m[h]).map((h) => [h, "auto" as const])));
    setAiReasons({});
    setStep("map");
    // Let AI take a pass at anything we couldn't match by name.
    if (config.aiEnabled && hs.some((h) => !m[h])) aiMap(hs, parsed.data, m);
  }

  async function onFile(f: File) {
    if (/\.(xlsx|xls|xlsm|ods)$/i.test(f.name)) {
      // Spreadsheets straight from Excel/Sheets: read the first sheet, keep cell text as displayed.
      const XLSX = await import("xlsx");
      const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      // Real date cells → YYYY-MM-DD (nudge by 12h to absorb SheetJS timezone drift; these are calendar dates).
      const pad = (n: number) => String(n).padStart(2, "0");
      for (const k of Object.keys(sheet)) {
        const c = sheet[k];
        if (c && c.t === "d" && c.v instanceof Date) {
          const d = new Date(c.v.getTime() + 12 * 3600e3);
          c.w = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
        }
      }
      loadText(XLSX.utils.sheet_to_csv(sheet, { blankrows: false, rawNumbers: true }), f.name);
      return;
    }
    if (!/\.(csv|txt|tsv)$/i.test(f.name)) {
      setError(`“${f.name}” isn't a CSV or Excel file. Export your sheet as CSV or .xlsx and drop it here.`);
      return;
    }
    loadText(await f.text(), f.name);
  }

  async function aiMap(hs = headers, recs = records, current = mapping, only?: string[]) {
    const unmapped = only ?? hs.filter((h) => !current[h]);
    if (!unmapped.length) return;
    setAiMapBusy(true);
    try {
      const samples = Object.fromEntries(unmapped.map((h) => [h, recs.map((r) => r[h]).filter(Boolean).slice(0, 5)]));
      const res = await fetch("/api/ai/map", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ headers: unmapped, samples, taken: Object.values(current).filter(Boolean) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      const valid = new Set(FIELDS.map((f) => f.key));
      const taken = new Set(Object.values(current).filter(Boolean));
      const next = { ...current };
      const src: Record<string, "ai"> = {};
      const reasons: Record<string, string> = {};
      for (const [h, v] of Object.entries(data.mapping as Record<string, { field: string | null; reason: string }>)) {
        if (!(h in next)) continue;
        reasons[h] = v.reason;
        if (v.field && valid.has(v.field) && !taken.has(v.field)) {
          next[h] = v.field;
          taken.add(v.field);
          src[h] = "ai";
        }
      }
      // Merge into the latest mapping: never overwrite a column the user set while AI was thinking.
      setMapping((latest) => {
        const merged = { ...latest };
        const used = new Set(Object.values(latest).filter(Boolean));
        for (const h of Object.keys(src)) if (!latest[h] && next[h] && !used.has(next[h])) { merged[h] = next[h]; used.add(next[h]!); }
        return merged;
      });
      setMappingSource((s) => ({ ...s, ...src }));
      setAiReasons((r) => ({ ...r, ...reasons }));
    } catch (e) {
      setError(`AI mapping failed: ${e instanceof Error ? e.message : e}. You can still map columns by hand.`);
    } finally {
      setAiMapBusy(false);
    }
  }

  const [rowsMappingKey, setRowsMappingKey] = useState("");
  function goReview() {
    // Same mapping as last time → keep the admin's edits/exclusions instead of rebuilding from the file.
    const key = JSON.stringify(mapping);
    if (rows.length && key === rowsMappingKey) {
      setStep("review");
      return;
    }
    setRowsMappingKey(key);
    const mapped = applyMapping(records, mapping);
    setRows(
      mapped.map((orig, i) => {
        const { row, changes } = autofixRow(orig);
        return { id: i + 1, row, original: orig, autoChanges: changes, edited: {}, excluded: false };
      }),
    );
    setStep("review");
  }

  async function doImport() {
    setImporting(true);
    setError(null);
    try {
      const included = rows.filter((r) => !r.excluded);
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: included.map((r) => r.row), rowNumbers: included.map((r) => r.id), fileName, mode: updateExisting ? "upsert" : "insert", fields: Object.values(mapping).filter(Boolean) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      setResult({ ...data, excluded: rows.filter((r) => r.excluded) });
      setUpdateExisting(false);
      await refresh();
      setStep("done");
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setImporting(false);
    }
  }

  function reset() {
    setStep("upload");
    setResult(null);
    setRows([]);
    setError(null);
  }

  // Unmatched columns the AI hasn't weighed in on yet (it runs automatically on upload).
  const unseen = headers.filter((h) => !mapping[h] && !aiReasons[h]);
  const missingRequired = FIELDS.filter((f) => f.required && !Object.values(mapping).includes(f.key));

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1400px] items-center gap-6 px-6 py-3">
          <div className="flex items-center gap-2 font-semibold">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-slate-900 text-sm text-white">▦</span> Inventory Import
          </div>
          <Stepper step={step} />
          <div className="ml-auto text-xs text-slate-500">
            <b className="text-slate-800">{inventory.length}</b> items in inventory
            {inventory.length > 0 && step === "upload" && (
              <button
                className="ml-2 text-rose-600 hover:underline"
                onClick={async () => {
                  if (!confirm(`Delete all ${inventory.length} items from inventory? (demo reset)`)) return;
                  await fetch("/api/items", { method: "DELETE" });
                  refresh();
                }}
              >
                reset
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-6 py-6">
        {restored && (step === "map" || step === "review") && (
          <div className="mb-4 flex items-center justify-between rounded-lg border border-sky-200 bg-sky-50 px-4 py-2 text-sm text-sky-900">
            <span>Picked up where you left off with <b>{fileName}</b>, including your edits.</span>
            <span className="flex gap-3">
              <button className="text-sky-700 hover:underline" onClick={() => setRestored(false)}>OK</button>
              <button className="text-sky-700 hover:underline" onClick={() => { setRestored(false); reset(); }}>Start over</button>
            </span>
          </div>
        )}
        {error && (
          <div className="mb-4 flex items-start justify-between rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
            {error}
            <button onClick={() => setError(null)} className="ml-4 text-rose-500">✕</button>
          </div>
        )}

        {step === "upload" && (
          <div className="mx-auto max-w-2xl">
            <h1 className="text-2xl font-bold">Bring your inventory in</h1>
            <p className="mt-1 text-slate-600">
              Drop the CSV exported from your spreadsheet. Your column names don't need to match ours. We'll map them, fix what's safe to fix, and show you
              exactly what will be imported before anything is saved.
            </p>
            <label
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) onFile(f); }}
              className={`mt-6 flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-16 text-center transition ${dragging ? "border-indigo-500 bg-indigo-50" : "border-slate-300 bg-white hover:border-slate-400"}`}
            >
              <div className="text-4xl">📄</div>
              <div className="mt-3 font-medium">Drag & drop a CSV or Excel file here, or click to choose</div>
              <div className="mt-1 text-sm text-slate-500">Nothing is imported until you review and confirm.</div>
              <input type="file" accept=".csv,text/csv,.xlsx,.xls,.ods" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
            </label>
            <div className="mt-4 flex items-center gap-2 text-sm text-slate-600">
              Try a sample:
              {["items_messy.csv", "items_clean.csv"].map((f) => (
                <button key={f} onClick={async () => loadText(await fetch(`/samples/${f}`).then((r) => r.text()), f)} className="rounded-md border border-slate-300 bg-white px-2 py-1 hover:bg-slate-100">
                  {f}
                </button>
              ))}
            </div>
            {batches.length > 0 && (
              <div className="mt-8">
                <h2 className="text-sm font-semibold text-slate-700">Recent imports</h2>
                <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white text-sm">
                  {batches.slice(0, 5).map((b) => (
                    <li key={b.id} className="flex items-center gap-3 px-3 py-2">
                      <span className="font-medium">{b.fileName}</span>
                      <span className="text-xs text-slate-500">{new Date(b.at).toLocaleString()}</span>
                      <span className="ml-auto text-xs">
                        <span className="text-emerald-700">{b.imported} imported</span>
                        {(b.updated ?? 0) > 0 && <span className="text-sky-700"> · {b.updated} updated</span>}
                        {b.skipped > 0 && <span className="text-rose-700"> · {b.skipped} skipped</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {step === "map" && (
          <div className="mx-auto max-w-4xl">
            <h1 className="text-2xl font-bold">Match your columns</h1>
            <p className="mt-1 text-slate-600">
              We matched <b>{Object.values(mapping).filter(Boolean).length}</b> of {headers.length} columns in <b>{fileName}</b> ({records.length} rows).
              Check the ones that look off. Columns set to “Don't import” are ignored.
            </p>
            {aiMapBusy && <p className="mt-2 text-sm text-indigo-700">✨ AI is looking at the columns we couldn't match…</p>}
            {missingRequired.length > 0 && (
              <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                No column for required field{missingRequired.length > 1 ? "s" : ""}: <b>{missingRequired.map((f) => f.label).join(", ")}</b>. You can still continue and fill them in on the next step.
              </div>
            )}
            <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="px-3 py-2">Your column</th>
                    <th className="px-3 py-2">Sample values</th>
                    <th className="px-3 py-2">Imports as</th>
                  </tr>
                </thead>
                <tbody>
                  {[...headers].sort((a, b) => Number(!!mapping[a]) - Number(!!mapping[b]) || FIELDS.findIndex((f) => f.key === mapping[a]) - FIELDS.findIndex((f) => f.key === mapping[b])).map((h) => {
                    const src = mappingSource[h];
                    return (
                      <tr key={h} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-medium">{h.trim() || <i>(blank)</i>}</td>
                        <td className="max-w-[280px] truncate px-3 py-2 text-xs text-slate-500">
                          {records.map((r) => r[h]).filter(Boolean).slice(0, 3).join(" · ") || <i>empty</i>}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <select
                              value={mapping[h] ?? ""}
                              onChange={(e) => {
                                const v = e.target.value || null;
                                setMapping((m) => {
                                  const n = { ...m };
                                  for (const k of Object.keys(n)) if (v && n[k] === v) n[k] = null; // one column per field
                                  n[h] = v;
                                  return n;
                                });
                                setMappingSource((s) => ({ ...s, [h]: "you" }));
                              }}
                              className={`rounded-md border px-2 py-1 ${mapping[h] ? "border-slate-300" : "border-dashed border-slate-300 text-slate-400"}`}
                            >
                              <option value="">Don't import</option>
                              {[...new Set(FIELDS.map((f) => f.group))].map((g) => (
                                <optgroup key={g} label={g}>
                                  {FIELDS.filter((f) => f.group === g).map((f) => (
                                    <option key={f.key} value={f.key}>
                                      {f.label}
                                      {f.required ? " *" : ""}
                                    </option>
                                  ))}
                                </optgroup>
                              ))}
                            </select>
                            {src === "auto" && mapping[h] && <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-[11px] text-emerald-800" title="Matched by column name — no AI">name match</span>}
                            {src === "ai" && mapping[h] && <span className="rounded bg-indigo-100 px-1.5 py-0.5 text-[11px] text-indigo-800" title={`Suggested by AI: ${aiReasons[h] ?? ""}`}>✨ AI: {aiReasons[h]}</span>}
                            {src === "you" && mapping[h] && <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[11px] text-sky-800">set by you</span>}
                            {!mapping[h] && aiReasons[h] && <span className="text-[11px] text-slate-400" title={aiReasons[h]}>✨ {aiReasons[h]}</span>}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="mt-4 flex items-center gap-3">
              <button onClick={reset} className="text-sm text-slate-600 hover:text-slate-900">← Choose another file</button>
              {config.aiEnabled && unseen.length > 0 && (
                <button
                  disabled={aiMapBusy}
                  onClick={() => aiMap(headers, records, mapping, unseen)}
                  title={`AI will look at: ${unseen.join(", ")}`}
                  className="rounded-lg border border-indigo-300 bg-white px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-50 disabled:opacity-50"
                >
                  ✨ Ask AI to match {unseen.length} unmatched column{unseen.length === 1 ? "" : "s"}
                </button>
              )}
              <button onClick={goReview} className="ml-auto rounded-lg bg-slate-900 px-5 py-2.5 font-semibold text-white hover:bg-slate-700">
                Review {records.length} rows →
              </button>
            </div>
          </div>
        )}

        {step === "review" && (
          <Review
            rows={rows}
            setRows={(fn) => setRows(fn)}
            existing={existing}
            mappedFields={Object.values(mapping).filter(Boolean) as string[]}
            aiEnabled={config.aiEnabled}
            fileName={fileName}
            onBack={() => setStep("map")}
            onImport={doImport}
            importing={importing}
            updateExisting={updateExisting}
            setUpdateExisting={setUpdateExisting}
          />
        )}

        {step === "done" && result && <Done result={result} rows={rows} onAgain={reset} onFixRejects={(rs) => {
          // Put the rejected rows back into review so they can be fixed without leaving the app.
          setRows(rs);
          setStep("review");
        }} />}
      </main>
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const steps: [Step, string][] = [["upload", "Upload"], ["map", "Match columns"], ["review", "Review & fix"], ["done", "Done"]];
  const at = steps.findIndex(([s]) => s === step);
  return (
    <ol className="hidden items-center gap-2 text-xs md:flex">
      {steps.map(([s, label], i) => (
        <li key={s} className="flex items-center gap-2">
          <span className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold ${i < at ? "bg-emerald-500 text-white" : i === at ? "bg-slate-900 text-white" : "bg-slate-200 text-slate-500"}`}>
            {i < at ? "✓" : i + 1}
          </span>
          <span className={i === at ? "font-semibold" : "text-slate-500"}>{label}</span>
          {i < steps.length - 1 && <span className="text-slate-300">—</span>}
        </li>
      ))}
    </ol>
  );
}

function download(name: string, text: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  a.download = name;
  a.click();
}

function Done({ result, rows, onAgain, onFixRejects }: { result: ImportResult; rows: WorkRow[]; onAgain: () => void; onFixRejects: (rows: WorkRow[]) => void }) {
  const { imported, rejected, excluded } = result;
  const fixedCount = rows.filter((r) => imported.some((i) => i.sku === r.row.sku) && (r.autoChanges.length || Object.keys(r.edited).length)).length;
  return (
    <div className="mx-auto max-w-5xl">
      <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6">
        <div className="text-3xl">✅</div>
        <h1 className="mt-2 text-2xl font-bold text-emerald-900">
          {imported.length} item{imported.length === 1 ? "" : "s"} imported from {result.batch.fileName}
        </h1>
        <p className="mt-1 text-emerald-800">
          {(result.batch.updated ?? 0) > 0 && <>{result.batch.updated} of them updated items that already existed. </>}
          {fixedCount > 0 && <>{fixedCount} of them were cleaned up along the way. </>}
          {rejected.length > 0 ? <>{rejected.length} row{rejected.length === 1 ? " was" : "s were"} not imported because of problems (listed below). </> : <>Every row you included made it in. </>}
          {excluded.length > 0 && <>{excluded.length} row{excluded.length === 1 ? " was" : "s were"} excluded by you. </>}
          Inventory now has <b>{result.total}</b> items.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {(rejected.length > 0 || excluded.length > 0) && (
            <>
              <button
                onClick={() =>
                  onFixRejects([
                    ...rejected.map((r) => rows.find((w) => w.id === r.rowNumber)!).filter(Boolean),
                    ...excluded.map((r) => ({ ...r, excluded: false })),
                  ].sort((a, b) => a.id - b.id))
                }
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
              >
                Fix the {rejected.length + excluded.length} remaining rows here
              </button>
              <button
                onClick={() => {
                  const all = [...rejected.map((r) => ({ row: r.row, msg: r.errors.map((e) => `${e.field}: ${e.message}`).join(" | ") })), ...excluded.map((r) => ({ row: r.row, msg: "excluded during review" }))];
                  download(`not-imported-${result.batch.fileName}`, rowsToCsv(all.map((a) => a.row), (i) => all[i].msg));
                }}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-100"
              >
                Download rows not imported (CSV with reasons)
              </button>
            </>
          )}
          <button
            onClick={() => download(`imported-${result.batch.fileName.replace(/\.csv$/, "")}.json`, JSON.stringify(imported, null, 2))}
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-100"
          >
            Download imported items (JSON)
          </button>
          <button onClick={onAgain} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-100">
            Import another file
          </button>
        </div>
      </div>

      {rejected.length > 0 && (
        <section className="mt-6">
          <h2 className="font-semibold">Not imported</h2>
          <div className="mt-2 overflow-hidden rounded-xl border border-rose-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-rose-50 text-left text-xs text-rose-800">
                <tr><th className="px-3 py-2">Row</th><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Why</th></tr>
              </thead>
              <tbody>
                {rejected.map((r) => (
                  <tr key={r.rowNumber} className="border-t border-rose-100 align-top">
                    <td className="px-3 py-2 tabular-nums text-slate-500">{r.rowNumber}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.row.sku || "—"}</td>
                    <td className="px-3 py-2">{r.row.name || "—"}</td>
                    <td className="px-3 py-2 text-rose-700">{r.errors.map((e) => e.message).join("; ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="mt-6">
        <h2 className="font-semibold">Imported</h2>
        <div className="mt-2 max-h-[50vh] overflow-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500">
              <tr><th className="px-3 py-2">SKU</th><th className="px-3 py-2">Name</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">UoM</th><th className="px-3 py-2 text-right">Unit cost</th><th className="px-3 py-2 text-right">On hand</th><th className="px-3 py-2">Vendors</th><th className="px-3 py-2">Status</th></tr>
            </thead>
            <tbody>
              {imported.map((i) => (
                <tr key={i.sku} className="border-t border-slate-100">
                  <td className="px-3 py-1.5 font-mono text-xs">{i.sku}</td>
                  <td className="px-3 py-1.5">{i.name}</td>
                  <td className="px-3 py-1.5">{i.category}</td>
                  <td className="px-3 py-1.5">{i.uom}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">${i.unit_cost.toFixed(2)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{i.quantity_on_hand}</td>
                  <td className="px-3 py-1.5 text-xs text-slate-600">{i.vendors.map((v) => v.vendor_name + (v.is_preferred ? " ★" : "")).join(", ")}</td>
                  <td className="px-3 py-1.5 text-xs">{i.is_active ? "Active" : "Inactive"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
