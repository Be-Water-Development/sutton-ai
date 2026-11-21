// Shared, pure import logic: used by the browser (live validation while editing)
// and by the API (authoritative validation on commit).

export const CATEGORIES = ["raw-materials", "components", "finished-goods", "packaging", "supplies"] as const;
export const UOMS = ["EA", "BX", "KG", "M", "L"] as const;

export type RawRow = Record<string, string>;
export type FieldError = { field: string; message: string };
export type Change = { field: string; from: string; to: string; reason: string };

export type FieldDef = { key: string; label: string; required?: boolean; aliases: string[]; group: string };

const base: FieldDef[] = [
  { key: "sku", label: "SKU", required: true, aliases: ["item code", "item number", "part number", "part no", "item id", "product code"], group: "Core" },
  { key: "name", label: "Name", required: true, aliases: ["item name", "product name", "title", "item"], group: "Core" },
  { key: "description", label: "Description", aliases: ["desc", "details"], group: "Core" },
  { key: "category", label: "Category", required: true, aliases: ["type", "item category", "class"], group: "Core" },
  { key: "uom", label: "Unit of measure", required: true, aliases: ["unit of measure", "unit", "units", "uom"], group: "Core" },
  { key: "unit_cost", label: "Unit cost", required: true, aliases: ["cost", "unit cost ($)", "price", "unit price", "cost usd"], group: "Stock" },
  { key: "quantity_on_hand", label: "Qty on hand", aliases: ["qty on hand", "qty", "quantity", "on hand", "stock"], group: "Stock" },
  { key: "reorder_point", label: "Reorder point", aliases: ["reorder pt", "reorder", "min qty", "reorder level"], group: "Stock" },
  { key: "is_active", label: "Active", aliases: ["active", "active?", "enabled", "status"], group: "Flags" },
  { key: "lot_tracked", label: "Lot tracked", aliases: ["lot tracked", "lot", "lot tracking", "batch tracked"], group: "Flags" },
  { key: "tags", label: "Tags", aliases: ["tag", "labels", "keywords"], group: "Flags" },
  { key: "first_received_on", label: "First received", aliases: ["first received", "received", "received on", "date received"], group: "Dates" },
  { key: "discontinued_on", label: "Discontinued on", aliases: ["discontinued", "discontinued date", "end date"], group: "Dates" },
  { key: "length", label: "Length", aliases: ["len", "l"], group: "Dimensions" },
  { key: "width", label: "Width", aliases: ["w"], group: "Dimensions" },
  { key: "height", label: "Height", aliases: ["h"], group: "Dimensions" },
  { key: "dimension_unit", label: "Dimension unit", aliases: ["dim unit", "dimensions unit", "size unit"], group: "Dimensions" },
];
const vendorFields: FieldDef[] = [1, 2, 3].flatMap((n) => [
  { key: `vendor_${n}_name`, label: `Vendor ${n} name`, aliases: [`vendor ${n}`, `supplier ${n}`, `supplier ${n} name`], group: "Vendors" },
  { key: `vendor_${n}_sku`, label: `Vendor ${n} SKU`, aliases: [`supplier ${n} sku`], group: "Vendors" },
  { key: `vendor_${n}_unit_cost`, label: `Vendor ${n} unit cost`, aliases: [`vendor ${n} cost`, `supplier ${n} cost`], group: "Vendors" },
  { key: `vendor_${n}_lead_time_days`, label: `Vendor ${n} lead time`, aliases: [`vendor ${n} lead time`, `vendor ${n} lead days`], group: "Vendors" },
  { key: `vendor_${n}_preferred`, label: `Vendor ${n} preferred`, aliases: [`vendor ${n} is preferred`], group: "Vendors" },
]);
export const FIELDS: FieldDef[] = [...base, ...vendorFields];
export const FIELD_KEYS = FIELDS.map((f) => f.key);

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Deterministic header → field guess. Returns null for headers we should not import. */
export function guessMapping(headers: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const used = new Set<string>();
  for (const h of headers) {
    const n = norm(h);
    const hit = FIELDS.find(
      (f) => !used.has(f.key) && (norm(f.key) === n || norm(f.label) === n || f.aliases.some((a) => norm(a) === n)),
    );
    out[h] = hit ? hit.key : null;
    if (hit) used.add(hit.key);
  }
  return out;
}

export function applyMapping(records: RawRow[], mapping: Record<string, string | null>): RawRow[] {
  return records.map((rec) => {
    const row: RawRow = {};
    for (const [src, dest] of Object.entries(mapping)) if (dest) row[dest] = rec[src] ?? "";
    return row;
  });
}

// ---------- auto-fix ----------

const CATEGORY_SYNONYMS: Record<string, string> = {
  "raw material": "raw-materials", "raw materials": "raw-materials", raw: "raw-materials",
  component: "components", components: "components", part: "components", parts: "components",
  "finished good": "finished-goods", "finished goods": "finished-goods", finished: "finished-goods", product: "finished-goods",
  packaging: "packaging", package: "packaging", pack: "packaging",
  supply: "supplies", supplies: "supplies", consumable: "supplies", consumables: "supplies",
};
const UOM_SYNONYMS: Record<string, string> = {
  ea: "EA", each: "EA", pc: "EA", pcs: "EA", piece: "EA", pieces: "EA", unit: "EA", units: "EA",
  bx: "BX", box: "BX", boxes: "BX",
  kg: "KG", kgs: "KG", kilo: "KG", kilos: "KG", kilogram: "KG", kilograms: "KG",
  m: "M", meter: "M", meters: "M", metre: "M", metres: "M",
  l: "L", liter: "L", liters: "L", litre: "L", litres: "L",
};
const TRUE_WORDS = ["true", "t", "yes", "y", "1", "active"];
const FALSE_WORDS = ["false", "f", "no", "n", "0", "inactive"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const isBoolField = (k: string) => k === "is_active" || k === "lot_tracked" || /^vendor_\d_preferred$/.test(k);
const isMoneyField = (k: string) => k === "unit_cost" || /^vendor_\d_unit_cost$/.test(k);
const isIntField = (k: string) => k === "quantity_on_hand" || k === "reorder_point" || /^vendor_\d_lead_time_days$/.test(k);
const isDateField = (k: string) => k === "first_received_on" || k === "discontinued_on";

const pad = (n: number) => String(n).padStart(2, "0");
function validDate(y: number, m: number, d: number) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Fix a single value when the intent is unambiguous. Returns [newValue, reason] or null. */
export function fixValue(key: string, v: string): [string, string] | null {
  const t = v.replace(/\s+/g, " ").trim();
  if (t !== v && key !== "description") return [t, "Trimmed extra whitespace"];
  if (t === "") return null;

  if (key === "sku") {
    const m = t.toUpperCase().match(/^([A-Z]{4})[\s_.\-/]?([A-Z0-9]{3})$/);
    if (m && `${m[1]}-${m[2]}` !== t) return [`${m[1]}-${m[2]}`, "Normalized SKU format"];
  }
  if (key === "category") {
    const s = CATEGORY_SYNONYMS[norm(t)];
    if (s && s !== t) return [s, `Mapped “${t}” to a known category`];
  }
  if (key === "uom") {
    const s = UOM_SYNONYMS[norm(t)];
    if (s && s !== t) return [s, `Mapped “${t}” to a unit of measure`];
  }
  if (key === "dimension_unit") {
    const l = t.toLowerCase().replace(/\.$/, "");
    const s = ["inch", "inches", '"', "in"].includes(l) ? "in" : ["cm", "cms", "centimeter", "centimeters", "centimetre"].includes(l) ? "cm" : null;
    if (s && s !== t) return [s, "Normalized dimension unit"];
  }
  if (isBoolField(key)) {
    const l = t.toLowerCase();
    if (l !== "true" && TRUE_WORDS.includes(l)) return ["true", `Read “${t}” as true`];
    if (l !== "false" && FALSE_WORDS.includes(l)) return ["false", `Read “${t}” as false`];
  }
  if (isMoneyField(key)) {
    let s = t.replace(/^\$|\s*usd$/i, "").replace(/^\$/, "").trim();
    if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
    else if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", "."); // decimal comma, e.g. 20,34
    if (s !== t && /^\d+(\.\d+)?$/.test(s)) return [s, t.includes(",") && !t.includes(".") && s.includes(".") ? "Decimal comma → decimal point" : "Removed currency formatting"];
  }
  if (isIntField(key)) {
    let s = t;
    if (/^\d{1,3}(,\d{3})+$/.test(s)) s = s.replace(/,/g, "");
    else if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
    if (s !== t) return [s, "Removed number formatting"];
  }
  if (isDateField(key)) {
    let m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); // US spreadsheet export: MM/DD/YYYY
    if (m && validDate(+m[3], +m[1], +m[2])) return [`${m[3]}-${pad(+m[1])}-${pad(+m[2])}`, "Converted US date (MM/DD/YYYY)"];
    m = t.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/);
    if (m && validDate(+m[1], +m[2], +m[3])) return [`${m[1]}-${pad(+m[2])}-${pad(+m[3])}`, "Converted date format"];
    m = t.match(/^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/);
    if (m && MONTHS.includes(m[1].toLowerCase())) {
      const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
      if (validDate(+m[3], mo, +m[2])) return [`${m[3]}-${pad(mo)}-${pad(+m[2])}`, "Converted written date"];
    }
  }
  if (key === "tags") {
    const parts = t.split(/[;,|]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const s = [...new Set(parts)].join(";");
    if (s !== t) return [s, "Lowercased and de-duplicated tags"];
  }
  return null;
}

export function autofixRow(input: RawRow): { row: RawRow; changes: Change[] } {
  const row: RawRow = { ...input };
  const changes: Change[] = [];
  for (const key of Object.keys(row)) {
    let v = row[key] ?? "";
    for (let i = 0; i < 3; i++) {
      const f = fixValue(key, v);
      if (!f) break;
      changes.push({ field: key, from: v, to: f[0], reason: f[1] });
      v = f[0];
    }
    row[key] = v;
  }
  // Row-level: a discontinued item can't be active. If "active" was left blank, infer false.
  if ((row.discontinued_on ?? "") !== "" && (row.is_active ?? "") === "") {
    changes.push({ field: "is_active", from: "", to: "false", reason: "Discontinued items must be inactive" });
    row.is_active = "false";
  }
  // Collapse multiple field changes into a single from→to per field for display
  const merged = new Map<string, Change>();
  for (const c of changes) {
    const prev = merged.get(c.field);
    merged.set(c.field, prev ? { ...c, from: prev.from, reason: `${prev.reason}; ${c.reason}` } : c);
  }
  return { row, changes: [...merged.values()] };
}

// ---------- validation ----------

const DEC = /^\d+(\.\d{1,4})?$/;
const INT = /^\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateRow(row: RawRow): FieldError[] {
  const e: FieldError[] = [];
  const g = (k: string) => (row[k] ?? "").trim();
  const err = (field: string, message: string) => e.push({ field, message });

  const sku = g("sku");
  if (!sku) err("sku", "SKU is required");
  else if (!/^[A-Z]{4}-[A-Z0-9]{3}$/.test(sku)) err("sku", "SKU must look like ABCD-1X2 (4 letters, dash, 3 letters/digits)");

  const name = g("name");
  if (!name) err("name", "Name is required");
  else if (name.length > 120) err("name", `Name is ${name.length} characters (max 120)`);

  const cat = g("category");
  if (!cat) err("category", "Category is required");
  else if (!(CATEGORIES as readonly string[]).includes(cat)) err("category", `“${cat}” is not a category. Use one of: ${CATEGORIES.join(", ")}`);

  const uom = g("uom");
  if (!uom) err("uom", "Unit of measure is required");
  else if (!(UOMS as readonly string[]).includes(uom)) err("uom", `“${uom}” is not a unit. Use one of: ${UOMS.join(", ")}`);

  const money = (k: string, label: string, required: boolean) => {
    const v = g(k);
    if (!v) { if (required) err(k, `${label} is required`); return; }
    if (/^-/.test(v)) err(k, `${label} can't be negative`);
    else if (!DEC.test(v)) err(k, /^\d+\.\d{5,}$/.test(v) ? `${label} has more than 4 decimal places` : `“${v}” is not a valid amount`);
  };
  const int = (k: string, label: string) => {
    const v = g(k);
    if (!v) return;
    if (/^-/.test(v)) err(k, `${label} can't be negative`);
    else if (!INT.test(v)) err(k, `${label} must be a whole number (got “${v}”)`);
  };
  const bool = (k: string, label: string) => {
    const v = g(k);
    if (v && v !== "true" && v !== "false") err(k, `${label} must be true or false (got “${v}”)`);
  };
  const date = (k: string, label: string) => {
    const v = g(k);
    if (!v) return;
    if (!DATE.test(v) || !validDate(+v.slice(0, 4), +v.slice(5, 7), +v.slice(8, 10))) err(k, `${label} must be a date like 2024-03-15 (got “${v}”)`);
  };

  money("unit_cost", "Unit cost", true);
  int("quantity_on_hand", "Qty on hand");
  int("reorder_point", "Reorder point");
  bool("is_active", "Active");
  bool("lot_tracked", "Lot tracked");
  date("first_received_on", "First received");
  date("discontinued_on", "Discontinued on");
  if (g("discontinued_on") && g("is_active") !== "false") err("is_active", "Discontinued items must have Active = false");

  const tags = g("tags");
  if (tags) {
    const parts = tags.split(";").map((t) => t.trim());
    if (parts.some((t) => t !== t.toLowerCase())) err("tags", "Tags must be lowercase");
    else if (new Set(parts).size !== parts.length) err("tags", "Tags must be unique");
  }

  const dims = ["length", "width", "height"];
  const given = dims.filter((d) => g(d));
  if (given.length && given.length < 3) {
    const missing = dims.filter((d) => !g(d));
    for (const d of missing) err(d, `Give length, width and height together (missing ${missing.join(", ")})`);
  }
  for (const d of given) {
    const v = g(d);
    if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) err(d, `${d[0].toUpperCase() + d.slice(1)} must be a number greater than 0`);
  }
  const du = g("dimension_unit");
  if (du && du !== "cm" && du !== "in") err("dimension_unit", "Dimension unit must be cm or in");

  let preferred = 0;
  for (const n of [1, 2, 3]) {
    const p = (f: string) => `vendor_${n}_${f}`;
    const any = ["name", "sku", "unit_cost", "lead_time_days", "preferred"].some((f) => g(p(f)));
    if (!any) continue;
    if (!g(p("name"))) err(p("name"), `Vendor ${n} needs a name`);
    money(p("unit_cost"), `Vendor ${n} unit cost`, true);
    int(p("lead_time_days"), `Vendor ${n} lead time`);
    bool(p("preferred"), `Vendor ${n} preferred`);
    if (g(p("preferred")) === "true") preferred++;
  }
  if (preferred > 1)
    for (const n of [1, 2, 3]) if (g(`vendor_${n}_preferred`) === "true") err(`vendor_${n}_preferred`, "Only one vendor can be preferred");
  return e;
}

/** Row index → duplicate message, across the file and already-imported SKUs. */
export function findDuplicateSkus(rows: RawRow[], existing: Set<string>, skip?: Set<number>): Map<number, string> {
  const out = new Map<number, string>();
  const seen = new Map<string, number[]>();
  rows.forEach((r, i) => {
    if (skip?.has(i)) return;
    const s = (r.sku ?? "").trim();
    if (!s) return;
    if (existing.has(s)) out.set(i, `SKU ${s} already exists in inventory`);
    seen.set(s, [...(seen.get(s) ?? []), i]);
  });
  for (const [s, idx] of seen) {
    if (idx.length > 1)
      for (const i of idx) if (!out.has(i)) out.set(i, `SKU ${s} appears ${idx.length} times in this file (rows ${idx.map((x) => x + 1).join(", ")})`);
  }
  return out;
}

export function validateAll(rows: RawRow[], existing: Set<string>, skip?: Set<number>): FieldError[][] {
  const dups = findDuplicateSkus(rows, existing, skip);
  return rows.map((r, i) => {
    const e = validateRow(r);
    const d = dups.get(i);
    if (d && !e.some((x) => x.field === "sku")) e.unshift({ field: "sku", message: d });
    return e;
  });
}

// ---------- canonical item ----------

export type Item = {
  sku: string; name: string; description?: string; category: string; uom: string; unit_cost: number;
  quantity_on_hand: number; reorder_point?: number; is_active: boolean; lot_tracked: boolean; tags: string[];
  first_received_on?: string; discontinued_on?: string;
  dimensions?: { length: number; width: number; height: number; unit: "cm" | "in" };
  vendors: { vendor_name: string; vendor_sku?: string; unit_cost: number; lead_time_days?: number; is_preferred: boolean }[];
};

export function toItem(row: RawRow): Item {
  const g = (k: string) => (row[k] ?? "").trim();
  const opt = <T,>(k: string, f: (s: string) => T) => (g(k) ? f(g(k)) : undefined);
  const item: Item = {
    sku: g("sku"),
    name: g("name"),
    description: row.description?.trim() || undefined,
    category: g("category"),
    uom: g("uom"),
    unit_cost: Number(g("unit_cost")),
    quantity_on_hand: g("quantity_on_hand") ? Number(g("quantity_on_hand")) : 0,
    reorder_point: opt("reorder_point", Number),
    is_active: g("is_active") ? g("is_active") === "true" : true,
    lot_tracked: g("lot_tracked") === "true",
    tags: g("tags") ? g("tags").split(";").map((t) => t.trim()).filter(Boolean) : [],
    first_received_on: opt("first_received_on", String),
    discontinued_on: opt("discontinued_on", String),
    vendors: [],
  };
  if (g("length")) item.dimensions = { length: +g("length"), width: +g("width"), height: +g("height"), unit: (g("dimension_unit") || "cm") as "cm" | "in" };
  for (const n of [1, 2, 3]) {
    const p = (f: string) => g(`vendor_${n}_${f}`);
    if (!p("name") && !p("unit_cost")) continue;
    item.vendors.push({
      vendor_name: p("name"),
      vendor_sku: p("sku") || undefined,
      unit_cost: Number(p("unit_cost")),
      lead_time_days: p("lead_time_days") ? Number(p("lead_time_days")) : undefined,
      is_preferred: p("preferred") === "true",
    });
  }
  return item;
}

export function rowsToCsv(rows: RawRow[], extra?: (i: number) => string): string {
  const cols = [...FIELD_KEYS, ...(extra ? ["import_errors"] : [])];
  const esc = (s: string) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  return [cols.join(","), ...rows.map((r, i) => cols.map((c) => esc(c === "import_errors" ? extra!(i) : r[c] ?? "")).join(","))].join("\n");
}
