# Kit Finder Workflow (sub-routine of protocol-plan)

This document is loaded by `protocol-plan` when the user needs verified catalog
numbers and product links for the reagents/kits called out in a plan. It used
to live as a standalone skill (`kit-finder`) and was merged in.

Use this workflow whenever:
- The user asks "where can I order these?" / "find catalog numbers"
- A generated execution plan lists reagents without specific Cat #s
- The user provides a list of reagents and wants vendor options

## Workflow

### Phase 1 — Extract Reagent Requirements

1. Read `references/vendor-catalog-reference.md` (in this same skill folder) for known catalog numbers.
2. Read any protocol or plan files in the project directory (`.md` files, especially in `.claude/plans/`) to identify reagents already mentioned.
3. Parse the input into a complete list of reagents/kits. For each protocol step, identify:
   - Primary kit or reagent (e.g., "TRIzol Reagent", "SYBR Green Master Mix")
   - Supporting reagents (e.g., chloroform, ethanol, RNase-free water)
   - Consumables with specific requirements (e.g., optical plates, filter tips)

### Phase 2 — Ask User for Preferences

Before searching, present the extracted reagent list and ask the user:

```
# Reagents Identified for Your Protocol

## Step 1: [Step Name]
1. [Reagent A] — e.g., TRIzol or equivalent lysis reagent
2. [Reagent B] — e.g., chloroform
...

**Do you already have preferred kits or catalog numbers for any of these?**
For example: "We use SYBR Select Master Mix (Cat# 4472908)" or "We prefer
QIAGEN kits for RNA extraction."

Reply with your preferences, or say "search all" to have me find options for everything.
```

### Phase 3 — Search for Options

For each reagent the user did **not** specify:

1. Search vendor sites with targeted queries — `"[reagent name]" site:[vendor-domain] catalog number`. Priority order:
   - `https://www.cell.com/star-protocols/home`
   - `https://www.nature.com/nprot/`
   - `thermofisher.com`
   - `qiagen.com`
   - `neb.com`
   - `bio-rad.com`
   - `sigmaaldrich.com` / `emdmillipore.com`
   - `takarabio.com`
   - `promega.com`
   - `idtdna.com` (primers/oligos)

   If the user passed `--vendor`, prioritize that domain.

2. For each reagent, find 2–3 options from different vendors when possible. Collect:
   - **Product name** (exact, as listed by vendor)
   - **Catalog number** (specific, not a product family)
   - **Vendor name**
   - **Direct product URL** (specific product page, not a search results page)
   - **Pack size / unit** (e.g., "500 mL", "200 rxns", "100 µg")
   - **Key specifications** (concentration, format, compatibility)

3. Verify product links with WebFetch when possible: catalog # matches the page, product is not discontinued, pack size and specs are correct.

### Phase 4 — Present Options for Confirmation

Organized by protocol step, with the recommended option highlighted:

```
# Kit & Reagent Options: [Protocol Name]

## Step 1: [Step Name]

### 1.1 [Reagent Category]

| # | Product | Catalog # | Vendor | Pack Size | Link |
|---|---------|-----------|--------|-----------|------|
| ▸ **A** | **[Recommended Product]** | **[Cat#]** | **[Vendor]** | **[Size]** | **[URL]** |
| B | [Alternative 1] | [Cat#] | [Vendor] | [Size] | [URL] |
| C | [Alternative 2] | [Cat#] | [Vendor] | [Size] | [URL] |

> **Recommendation:** Option A because [reason — most widely cited / includes all components / best value].

## Summary of Recommendations

| Step | Reagent | Recommended Product | Catalog # | Vendor | Link |
|------|---------|--------------------|-----------|--------|------|
| 1 | Lysis reagent | [Product] | [Cat#] | [Vendor] | [URL] |
| ... | ... | ... | ... | ... | ... |

**Please confirm your selections or specify changes.**
```

### Phase 5 — Finalize and Output

After confirmation, produce a Bill of Materials:

```
# Bill of Materials: [Protocol Name]

**Date:** [current date]
**Confirmed by:** User

| # | Product Name | Catalog # | Vendor | Pack Size | Product Link | Notes |
|---|-------------|-----------|--------|-----------|-------------|-------|
| 1 | [Exact product name] | [Cat#] | [Vendor] | [Size] | [URL] | [Notes] |
| 2 | ... | ... | ... | ... | ... | ... |

## Ordering Notes
- [Special ordering instructions, e.g., "Ships on dry ice", "Requires hazmat shipping"]
- [Storage requirements upon receipt]
- [Items that may already be in common lab stock]
```

### Phase 6 — Download Kit Documentation

After the BOM is finalized:

1. For each confirmed kit/reagent, search for its product documentation:
   - Query format: `"[product name]" "[catalog number]" manual PDF site:[vendor-domain]`
   - Look for: product manual, user guide, protocol sheet, technical data sheet
   - Also check the product page URL for documentation download links

2. Download each PDF (or save the product page as markdown if no PDF) to `references/kit-docs/` in the project workspace:
   - PDF filename: `[Vendor]_[ProductName]_[CatalogNumber].pdf` (spaces → hyphens)
   - Example: `ThermoFisher_TRIzol-Reagent_15596026.pdf`
   - Fallback: `[Vendor]_[ProductName]_[CatalogNumber]_product-page.md`

3. Report:

```
# Kit Documentation Downloaded

| # | Product | Catalog # | File | Status |
|---|---------|-----------|------|--------|
| 1 | [Product] | [Cat#] | [filename] | ✅ Downloaded |
| 2 | [Product] | [Cat#] | [filename] | ⚠️ PDF not found — product page saved |
| 3 | [Product] | [Cat#] | — | ❌ No documentation found |

Files saved to: `references/kit-docs/`
```

## Important Guidelines

- **Catalog numbers must be specific** — never product family codes. Use `4472908` (SYBR Select Master Mix, 10 × 5 mL), not the family page.
- **Links must point to the specific product page** — not search results, not family overviews. The URL should contain the catalog number or lead directly to the product with that catalog number visible.
- **Distinguish pack sizes** — same product often has multiple Cat #s for different quantities (50 rxns vs. 200 rxns). Default to common lab-scale unless the user specifies.
- **Flag discontinued products** — note them and suggest replacements.
- **Note kit contents** — list what's bundled so the user knows what they don't need to order separately.
- **Consider compatibility** — when recommending across steps (RT kit + qPCR master mix), prefer products from the same vendor or explicitly validated together.
- **Common lab stock items** — for commodities (ethanol, isopropanol, chloroform, water), still provide Cat #s but note they may already be on the shelf.
- **Always include web references** with direct URLs.
- **Do not guess catalog numbers** — if you cannot verify one through web search, say so and provide the best product page link found.
