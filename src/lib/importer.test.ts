import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import Papa from "papaparse";
import { guessMapping, applyMapping, autofixRow, validateRow, validateAll, toItem, fixValue } from "./importer";

const load = (f: string) => {
  const p = Papa.parse<Record<string, string>>(readFileSync(`samples/${f}`, "utf8"), { header: true, skipEmptyLines: "greedy" });
  const headers = p.meta.fields!;
  return { headers, rows: applyMapping(p.data, guessMapping(headers)) };
};

describe("clean file", () => {
  it("imports all 25 rows with zero errors", () => {
    const { rows } = load("items_clean.csv");
    expect(rows).toHaveLength(25);
    const errs = validateAll(rows.map((r) => autofixRow(r).row), new Set());
    expect(errs.flat()).toEqual([]);
    expect(toItem(rows[0]).vendors[0].vendor_name).toBe("Northwind Supply");
  });
});

describe("messy file", () => {
  it("maps every header except internal notes", () => {
    const { headers } = load("items_messy.csv");
    const m = guessMapping(headers);
    expect(Object.entries(m).filter(([, v]) => !v).map(([k]) => k)).toEqual(["Internal Notes"]);
    expect(m["SKU "]).toBe("sku");
    expect(m["Unit Cost ($)"]).toBe("unit_cost");
  });
  it("auto-fix reduces errors", () => {
    const { rows } = load("items_messy.csv");
    const before = validateAll(rows, new Set()).filter((e) => e.length).length;
    const after = validateAll(rows.map((r) => autofixRow(r).row), new Set()).filter((e) => e.length).length;
    console.log({ before, after });
    expect(after).toBeLessThan(before);
  });
});

describe("rules", () => {
  const ok = { sku: "PACK-7Q2", name: "Box", category: "packaging", uom: "EA", unit_cost: "1.5" };
  it("valid minimal row", () => expect(validateRow(ok)).toEqual([]));
  it("bad sku", () => expect(validateRow({ ...ok, sku: "pack-7q2" })[0].field).toBe("sku"));
  it("discontinued but active", () => expect(validateRow({ ...ok, discontinued_on: "2025-01-01", is_active: "true" })[0].field).toBe("is_active"));
  it("two preferred vendors", () =>
    expect(validateRow({ ...ok, vendor_1_name: "A", vendor_1_unit_cost: "1", vendor_1_preferred: "true", vendor_2_name: "B", vendor_2_unit_cost: "1", vendor_2_preferred: "true" })).toHaveLength(2));
  it("partial dimensions", () => expect(validateRow({ ...ok, length: "2" }).map((e) => e.field)).toEqual(["width", "height"]));
  it("dup skus across file and existing", () => {
    const e = validateAll([ok, ok, { ...ok, sku: "ABCD-123" }], new Set(["ABCD-123"]));
    expect(e.map((x) => x.length)).toEqual([1, 1, 1]);
  });
});

describe("fixes", () => {
  const f = (k: string, v: string) => fixValue(k, v)?.[0];
  it("sku", () => expect(f("sku", "jfzm-ud4")).toBe("JFZM-UD4"));
  it("money", () => { expect(f("unit_cost", "$15.39")).toBe("15.39"); expect(f("unit_cost", "20,34")).toBe("20.34"); expect(f("unit_cost", "TBD")).toBeUndefined(); expect(f("unit_cost", "-5")).toBeUndefined(); });
  it("ints", () => { expect(f("quantity_on_hand", "1,200")).toBe("1200"); expect(f("quantity_on_hand", "12.5")).toBeUndefined(); });
  it("dates", () => { expect(f("first_received_on", "Oct 24, 2024")).toBe("2024-10-24"); expect(f("first_received_on", "05/09/2024")).toBe("2024-05-09"); });
  it("tags", () => expect(autofixRow({ tags: "Metal;metal; METAL" }).row.tags).toBe("metal"));
  it("category", () => { expect(f("category", "Raw Material")).toBe("raw-materials"); expect(f("category", "Misc")).toBeUndefined(); });
  it("bool", () => { expect(f("is_active", "yes")).toBe("true"); expect(f("lot_tracked", "maybe")).toBeUndefined(); });
});
