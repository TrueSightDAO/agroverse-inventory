# agroverse-inventory

Public **store inventory snapshot** for [agroverse.shop](https://agroverse.shop): SKU product IDs → numeric stock counts. Data is **generated**—do not hand-edit the JSON.

## Canonical file

| | |
|---|---|
| **Branch** | `main` |
| **File** | [`store-inventory.json`](store-inventory.json) |
| **HTTPS (browsers / `fetch`)** | `https://raw.githubusercontent.com/TrueSightDAO/agroverse-inventory/main/store-inventory.json` |

## JSON shape

```json
{
  "generatedAt": "2026-04-07T19:56:10.893Z",
  "source": "update_store_inventory",
  "inventory": {
    "oscar-bahia-ceremonial-cacao-200g": 68,
    "...": 0
  }
}
```

Consumers should read **`inventory`** (map of product id → count). `generatedAt` is ISO-8601 UTC from the last successful publish.

## How it is updated

1. **Google Apps Script** project **`update_store_inventory`** ([editor](https://script.google.com/home/projects/1P0Mg33i_dD9x9IeoHYvtKrf0xFcmUznpqAswyC_KXR3VJZu-0C-UOP0v/edit)) recomputes counts from DAO ledgers and **Agroverse SKUs** (see tokenomics clasp mirror under `tokenomics/clasp_mirrors/1P0Mg33i…/`).
2. It pushes this file via the **GitHub Contents API** using a fine-grained PAT stored only in **Apps Script → Project Settings → Script properties** as **`AGROVERSE_INVENTORY_GIT_REPO_UPDATE_PAT`**. **Never commit that token to this repo.**
3. OAuth: **`appsscript.json`** must include **`https://www.googleapis.com/auth/script.external_request`**; the script owner must authorize external requests (see `authorizeUrlFetchForSnapshot()` in the GAS project).
4. Triggers: **time-driven** `updateStoreInventory` (e.g. hourly) and **HTTP** actions `publishInventorySnapshot` / `recalculateAndPublishInventory` (shared secret **`AGROVERSE_INVENTORY_PUBLISH_SECRET`**).
5. **sentiment_importer** (Edgar) may enqueue **`AgroverseInventorySnapshotPublishWorker`** after Meta/QR checkout and after successful ledger **`WebhookTriggerWorker`** runs (`dao_controller#trigger_immediate_processing`). Configure **`AGROVERSE_INVENTORY_GAS_WEBAPP_URL`** and **`AGROVERSE_INVENTORY_PUBLISH_SECRET`** on the Edgar host.

Commits may be **skipped** when the `inventory` map is unchanged (no useless churn).

## Shop frontend

**agroverse_shop** loads inventory via **`js/inventory-service.js`**: prefers this **raw GitHub** URL, falls back to the GAS **`getInventory`** endpoint if the fetch fails.

## Docs in workspace

See **`agentic_ai_context`**: `PROJECT_INDEX.md` (this repo), `API_CREDENTIALS_DOCUMENTATION.md` (GAS Script properties + Edgar env vars), `WORKSPACE_CONTEXT.md` (cross-repo flow).
