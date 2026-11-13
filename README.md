# Frontify Asset Deleter

A small Node.js script that bulk-deletes Frontify assets listed in a CSV file, using the Frontify GraphQL API (`deleteAsset` mutation).

> **Warning:** deletions are performed against a live Frontify instance. Always run with `--dry-run` first.

## Requirements

- Node.js 18+ (uses the built-in `fetch`)
- A Frontify personal developer token with the `basic:write` scope and Edit permission on the assets to delete. Create one at `https://<your-domain>/oauth-access-token`.

## Setup

1. Copy the example env file and fill it in:

   ```bash
   cp .env.example .env
   ```

   ```
   FRONTIFY_DOMAIN=acme.frontify.com
   FRONTIFY_TOKEN=your_personal_developer_token
   ```

2. Never commit `.env`. It is listed in `.gitignore`.

## CSV format

The CSV must have a header row including an `AssetId` column (the legacy numeric asset ID). `AssetName` and `LibraryName` are optional and used only for logging. Quoted fields containing commas are supported.

Start from [`deletion-list.template.csv`](deletion-list.template.csv):

```
BrandId,BrandName,LibraryId,LibraryName,LibraryType,AssetId,AssetName,AssetExtension
1,Example Brand,100,Example Library,MEDIALIBRARY,123456,example-asset-one,jpg
```

Duplicate `AssetId`s are removed automatically. Numeric IDs are converted to Frontify global IDs (`base64({"identifier":<id>,"type":"asset"})`) before the API call.

## Usage

Preview what would be deleted (no API calls):

```bash
node delete-assets.mjs "your-list.csv" --dry-run
```

Run the deletion:

```bash
node delete-assets.mjs "your-list.csv"
```

## Resuming and failures

- **Checkpoint:** each successful deletion is appended to `<csv-name>.checkpoint`. If the run is interrupted, re-run the same command and completed assets are skipped. Delete the checkpoint file to start fresh.
- **Failures:** failed assets are appended as JSON lines (with the error message) to `<csv-name>.failed`, and the process exits with code 1.
- **Rate limiting:** the API allows 2500 requests per 5 minutes. On an HTTP 429 the script stops immediately; wait for the window to reset and re-run to resume.

## Files

| File | Purpose |
| --- | --- |
| `delete-assets.mjs` | The deletion script |
| `deletion-list.template.csv` | Blank CSV template (copy it and fill in your asset IDs) |
| `.env.example` | Template for required environment variables |

CSV inputs, checkpoint/failed logs, and `.env` contain client data or credentials and are excluded from version control via `.gitignore`.
