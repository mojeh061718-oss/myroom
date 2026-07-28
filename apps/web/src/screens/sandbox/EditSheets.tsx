import { useMemo, useState } from "react";
import { CATEGORY_GROUPS, OBJECT_CATEGORIES, getCategory, modelsForCategory } from "@myroom/catalog";
import { formatLength } from "@myroom/geometry";
import type { PlacedObject } from "@myroom/schema";
import { Sheet } from "../../components/Sheet.js";
import { PillButton } from "../../components/PillButton.js";

/** docs/06 §4 — curated designer palettes plus a free hex field. */
export const PALETTES: { name: string; colors: string[] }[] = [
  { name: "Warm neutrals", colors: ["#EDE9E3", "#E3DBCF", "#D6C9B8", "#C2B8A6", "#A89C8C"] },
  { name: "Sage & stone", colors: ["#9CAF88", "#B7C4A8", "#7E8F6E", "#C9CFC2", "#5F6B54"] },
  { name: "Clay & terracotta", colors: ["#C97B5A", "#D9A183", "#B4653F", "#E8C4AC", "#8A4A2E"] },
  { name: "Deep & moody", colors: ["#2F3A3F", "#3E4C52", "#22303A", "#54666E", "#16202A"] },
  { name: "Blues", colors: ["#4C6E8F", "#7796B0", "#33506B", "#A9BDD0", "#22394D"] },
  { name: "Whites", colors: ["#FFFFFF", "#F7F5F1", "#EFEBE4", "#E5E0D8", "#DAD4CA"] },
];

const FLOOR_MATERIALS = [
  { name: "Oak", color: "#B99A72" },
  { name: "Walnut", color: "#7A5B41" },
  { name: "Ash", color: "#D2BFA3" },
  { name: "Concrete", color: "#9C9C99" },
  { name: "Slate tile", color: "#5A5F63" },
  { name: "Warm carpet", color: "#A99884" },
];

function isHex(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

interface ColorSheetProps {
  open: boolean;
  title: string;
  swatches?: { name: string; color: string }[];
  onPick: (color: string) => void;
  onClose: () => void;
  extraAction?: { label: string; onClick: () => void };
}

export function ColorSheet({ open, title, swatches, onPick, onClose, extraAction }: ColorSheetProps) {
  const [hex, setHex] = useState("");
  return (
    <Sheet open={open} onClose={onClose} labelledBy="color-sheet-title">
      <h2 id="color-sheet-title" className="type-title" style={{ margin: "0 0 4px" }}>
        {title}
      </h2>
      {swatches ? (
        <div className="swatch-grid" data-testid="material-swatches">
          {swatches.map((s) => (
            <button key={s.name} className="swatch" style={{ background: s.color }} aria-label={s.name} onClick={() => onPick(s.color)}>
              <span className="type-caption">{s.name}</span>
            </button>
          ))}
        </div>
      ) : (
        PALETTES.map((p) => (
          <div key={p.name} style={{ marginTop: 12 }}>
            <div className="type-caption">{p.name}</div>
            <div className="palette-row">
              {p.colors.map((c) => (
                <button
                  key={c}
                  className="palette-chip"
                  style={{ background: c }}
                  aria-label={`${p.name} ${c}`}
                  data-testid={`swatch-${c}`}
                  onClick={() => onPick(c)}
                />
              ))}
            </div>
          </div>
        ))
      )}
      <form
        style={{ display: "flex", gap: 8, marginTop: 16 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (isHex(hex)) onPick(hex);
        }}
      >
        <input
          className="hex-field"
          placeholder="#9CAF88"
          value={hex}
          aria-label="Custom colour hex"
          onChange={(e) => setHex(e.target.value)}
        />
        <PillButton type="submit" variant="primary" disabled={!isHex(hex)}>
          Apply
        </PillButton>
      </form>
      {extraAction && (
        <PillButton style={{ marginTop: 12, width: "100%" }} onClick={extraAction.onClick}>
          {extraAction.label}
        </PillButton>
      )}
    </Sheet>
  );
}

interface CatalogSheetProps {
  open: boolean;
  onClose: () => void;
  onPick: (categoryId: string, catalogId?: string) => void;
  /** clearance at the tapped spot, for the "fits here" filter (docs/06 §5) */
  fitsWithin?: { w: number; d: number } | null;
  title?: string;
}

/** docs/06 §5 — categories, text search, and a size-aware "fits here" filter. */
export function CatalogSheet({ open, onClose, onPick, fitsWithin, title }: CatalogSheetProps) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<string | "all">("all");
  const [fitsOnly, setFitsOnly] = useState(false);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return OBJECT_CATEGORIES.filter((c) => {
      if (group !== "all" && c.group !== group) return false;
      if (fitsOnly && fitsWithin) {
        if (c.defaultSize.w > fitsWithin.w || c.defaultSize.d > fitsWithin.d) return false;
      }
      if (!q) return true;
      return (
        c.label.toLowerCase().includes(q) ||
        c.id.includes(q) ||
        c.detectionPrompts.some((p) => p.includes(q))
      );
    });
  }, [query, group, fitsOnly, fitsWithin]);

  return (
    <Sheet open={open} onClose={onClose} labelledBy="catalog-title">
      <h2 id="catalog-title" className="type-title" style={{ margin: "0 0 8px" }}>
        {title ?? "Add to the room"}
      </h2>
      <input
        className="hex-field"
        style={{ width: "100%" }}
        placeholder="Search — sofa, microwave, picture…"
        value={query}
        aria-label="Search the catalog"
        data-testid="catalog-search"
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="chip-row">
        <button className={`chip ${group === "all" ? "active" : ""}`} onClick={() => setGroup("all")}>
          All
        </button>
        {CATEGORY_GROUPS.map((g) => (
          <button key={g} className={`chip ${group === g ? "active" : ""}`} onClick={() => setGroup(g)}>
            {g}
          </button>
        ))}
        {fitsWithin && (
          <button
            className={`chip ${fitsOnly ? "active" : ""}`}
            aria-pressed={fitsOnly}
            data-testid="fits-here"
            onClick={() => setFitsOnly((f) => !f)}
          >
            Fits here
          </button>
        )}
      </div>
      <div className="catalog-grid" data-testid="catalog-grid">
        {results.slice(0, 120).flatMap((c) => {
          const models = modelsForCategory(c.id);
          // A category with real CC0 models offers each one; categories still
          // awaiting a model offer their parametric stand-in (docs/05 §6).
          if (models.length === 0) {
            return [
              <button key={c.id} className="catalog-item" data-testid={`catalog-${c.id}`} onClick={() => onPick(c.id)}>
                <span className="type-label">{c.label}</span>
                <span className="type-caption">
                  {formatLength(c.defaultSize.w, "m")} × {formatLength(c.defaultSize.d, "m")}
                </span>
              </button>,
            ];
          }
          return models.map((m, i) => (
            <button
              key={m.id}
              className="catalog-item"
              data-testid={i === 0 ? `catalog-${c.id}` : `catalog-${c.id}-${i}`}
              onClick={() => onPick(c.id, m.id)}
            >
              <span className="type-label">{m.name}</span>
              <span className="type-caption">
                {formatLength(m.nativeSize.w, "m")} × {formatLength(m.nativeSize.d, "m")} · CC0
              </span>
            </button>
          ));
        })}
        {results.length === 0 && <p className="type-caption">Nothing matches that search.</p>}
      </div>
    </Sheet>
  );
}

interface ObjectSheetProps {
  object: PlacedObject | null;
  onClose: () => void;
  onPaintSlot: (slot: string, color: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onSwap: () => void;
  onResize: (scale: number) => void;
  onRotate: () => void;
  unit: "m" | "ft";
}

/** docs/06 §3–4 — everything you can do to one selected object. */
export function ObjectSheet({
  object,
  onClose,
  onPaintSlot,
  onDuplicate,
  onDelete,
  onSwap,
  onResize,
  onRotate,
  unit,
}: ObjectSheetProps) {
  const [slot, setSlot] = useState<string | null>(null);
  const category = object?.placeholder ? getCategory(object.placeholder.category) : undefined;
  const slots = category?.materialSlots ?? [];

  return (
    <>
      <Sheet open={object !== null && slot === null} onClose={onClose} labelledBy="object-title">
        {object && (
          <>
            <h2 id="object-title" className="type-title" style={{ margin: 0 }}>
              {object.label}
            </h2>
            <p className="type-metric" style={{ margin: "4px 0 12px", color: "var(--text-dim)" }}>
              {formatLength(object.size.w, unit)} × {formatLength(object.size.d, unit)} ×{" "}
              {formatLength(object.size.h, unit)}
            </p>
            <div className="chip-row">
              {slots.map((s) => (
                <button key={s} className="chip" data-testid={`slot-${s}`} onClick={() => setSlot(s)}>
                  Paint {s}
                </button>
              ))}
            </div>
            <div className="object-actions">
              <PillButton onClick={onRotate} data-testid="rotate-object">
                Rotate 45°
              </PillButton>
              <PillButton onClick={() => onResize(1.1)} data-testid="grow-object">
                Bigger
              </PillButton>
              <PillButton onClick={() => onResize(1 / 1.1)}>Smaller</PillButton>
              <PillButton onClick={onSwap} data-testid="swap-object">
                Swap…
              </PillButton>
              <PillButton onClick={onDuplicate} data-testid="duplicate-object">
                Duplicate
              </PillButton>
              <PillButton variant="danger" onClick={onDelete} data-testid="delete-object">
                Delete
              </PillButton>
            </div>
          </>
        )}
      </Sheet>

      <ColorSheet
        open={slot !== null}
        title={`Paint ${slot ?? ""}`}
        onPick={(color) => {
          if (slot) onPaintSlot(slot, color);
          setSlot(null);
        }}
        onClose={() => setSlot(null)}
      />
    </>
  );
}

export { FLOOR_MATERIALS };
