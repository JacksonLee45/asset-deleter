#!/usr/bin/env node
/**
 * Frontify Asset Deleter
 *
 * Reads asset IDs from a CSV file and deletes them via the Frontify GraphQL API.
 *
 * Usage:
 *   node delete-assets.mjs "PT MAP - asset Deletion list_example.csv" [--dry-run]
 *
 * Create a .env file in this directory with:
 *   FRONTIFY_DOMAIN=acme.frontify.com
 *   FRONTIFY_TOKEN=your_token
 *
 * FRONTIFY_TOKEN — personal developer token from https://<domain>/oauth-access-token
 *                  (requires basic:write scope and Edit permission on the assets)
 *
 * Flags:
 *   --dry-run   Parse the CSV and log what would be deleted, without calling the API.
 *
 * Resume:
 *   If interrupted, re-run the same command. A checkpoint file (<csv-name>.checkpoint)
 *   tracks completed asset IDs so already-deleted assets are automatically skipped.
 *   Delete the checkpoint file to start fresh.
 */

import { readFileSync, existsSync, appendFileSync } from 'fs';
import { basename } from 'path';

// Load .env from the same directory as this script.
const envPath = new URL('.env', import.meta.url).pathname;
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(key in process.env)) process.env[key] = val;
  }
}

const DOMAIN = process.env.FRONTIFY_DOMAIN;
const TOKEN = process.env.FRONTIFY_TOKEN;
const CSV_FILE = process.argv[2];
const DRY_RUN = process.argv.includes('--dry-run');

// ~8 req/s delay budget. Real throughput is lower once network round-trip is
// included, keeping us comfortably under the 2500 req / 5-min rolling limit.
const DELAY_MS = 0;

// Frontify global IDs are base64({"identifier":<int>,"type":"asset"}).
// The numeric IDs in the CSV are the legacy integer identifiers.
function encodeGlobalId(numericId) {
  const payload = JSON.stringify({ identifier: parseInt(numericId, 10), type: 'asset' });
  return Buffer.from(payload).toString('base64');
}

async function graphql(query, variables) {
  const res = await fetch(`https://${DOMAIN}/graphql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401) throw new Error('401 Unauthorized — check your FRONTIFY_TOKEN');
  if (res.status === 429) throw new Error('429 Too Many Requests — rate limit hit, stopping');
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const body = await res.text();
    throw new Error(
      `Expected JSON but got ${contentType || 'unknown content-type'}.\n` +
      `This usually means the domain or endpoint is wrong, or the request was redirected to a login page.\n` +
      `Response preview: ${body.slice(0, 300)}`
    );
  }

  return res.json();
}

const DELETE_ASSET_MUTATION = /* GraphQL */ `
  mutation DeleteAsset($input: DeleteAssetInput!) {
    deleteAsset(input: $input) {
      id
    }
  }
`;

// Minimal CSV parser that handles quoted fields containing commas.
function parseCSV(content) {
  const lines = content.trim().split(/\r?\n/);
  const headers = splitCSVLine(lines[0]);
  const assetIdIdx = headers.indexOf('AssetId');

  if (assetIdIdx === -1) {
    throw new Error(`CSV is missing an "AssetId" column. Found: ${headers.join(', ')}`);
  }

  const nameIdx = headers.indexOf('AssetName');
  const libraryIdx = headers.indexOf('LibraryName');

  return lines.slice(1)
    .filter(line => line.trim())
    .map((line, i) => {
      const cols = splitCSVLine(line);
      const assetId = cols[assetIdIdx]?.trim();
      if (!assetId || isNaN(Number(assetId))) {
        throw new Error(`Row ${i + 2}: invalid AssetId "${assetId}"`);
      }
      return {
        assetId,
        assetName: cols[nameIdx]?.trim() ?? '',
        libraryName: cols[libraryIdx]?.trim() ?? '',
      };
    });
}

function splitCSVLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else { inQuote = !inQuote; }
    } else if (ch === ',' && !inQuote) {
      fields.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Checkpoint: one asset ID per line, written after each successful deletion.
// Lets the script resume from where it left off if interrupted.
function loadCheckpoint(checkpointPath) {
  if (!existsSync(checkpointPath)) return new Set();
  return new Set(
    readFileSync(checkpointPath, 'utf-8').split(/\r?\n/).filter(Boolean)
  );
}

function markCheckpoint(checkpointPath, assetId) {
  appendFileSync(checkpointPath, assetId + '\n');
}

async function main() {
  if (!DOMAIN) { console.error('Error: FRONTIFY_DOMAIN env var is required'); process.exit(1); }
  if (!TOKEN) { console.error('Error: FRONTIFY_TOKEN env var is required'); process.exit(1); }
  if (!CSV_FILE) {
    console.error('Usage: node delete-assets.mjs <csv-file> [--dry-run]');
    process.exit(1);
  }

  let csvContent;
  try {
    csvContent = readFileSync(CSV_FILE, 'utf-8');
  } catch {
    console.error(`Error: could not read file "${CSV_FILE}"`);
    process.exit(1);
  }

  const assets = parseCSV(csvContent);
  const uniqueAssets = [...new Map(assets.map(a => [a.assetId, a])).values()];

  if (uniqueAssets.length < assets.length) {
    console.warn(`Note: ${assets.length - uniqueAssets.length} duplicate AssetId(s) removed.`);
  }

  const checkpointPath = `${CSV_FILE}.checkpoint`;
  const failedPath = `${CSV_FILE}.failed`;
  const completed = DRY_RUN ? new Set() : loadCheckpoint(checkpointPath);
  const pending = uniqueAssets.filter(a => !completed.has(a.assetId));

  const etaMins = ((pending.length * DELAY_MS) / 60_000).toFixed(1);

  console.log(`\nFrontify Asset Deleter`);
  console.log(`Domain    : ${DOMAIN}`);
  console.log(`CSV       : ${basename(CSV_FILE)}`);
  console.log(`Total     : ${uniqueAssets.length}`);
  console.log(`Completed : ${completed.size} (skipping — already done)`);
  console.log(`Pending   : ${pending.length}`);
  if (!DRY_RUN) console.log(`Est. time : ~${etaMins} min`);
  if (DRY_RUN) console.log(`Mode      : DRY RUN (no changes will be made)`);
  console.log('');

  const failed = [];

  for (let i = 0; i < pending.length; i++) {
    const { assetId, assetName, libraryName } = pending[i];
    const label = `[${i + 1}/${pending.length}] ${assetId} — ${assetName} (${libraryName})`;

    if (DRY_RUN) {
      console.log(`  DRY RUN  ${label}`);
      continue;
    }

    const globalId = encodeGlobalId(assetId);

    try {
      const response = await graphql(DELETE_ASSET_MUTATION, { input: { id: globalId } });

      if (response.errors?.length) {
        const msg = response.errors.map(e => e.message).join(' | ');
        console.error(`  FAILED   ${label}\n           ${msg}`);
        failed.push({ assetId, assetName, libraryName, error: msg });
        appendFileSync(failedPath, JSON.stringify({ assetId, assetName, libraryName, error: msg }) + '\n');
      } else {
        console.log(`  DELETED  ${label}`);
        markCheckpoint(checkpointPath, assetId);
      }
    } catch (err) {
      // 429 is fatal — stop immediately to avoid extending the rate-limit block.
      if (err.message.startsWith('429')) {
        console.error(`\n${err.message}`);
        console.error('Stopping. Re-run the same command to resume after the 5-minute window resets.');
        break;
      }
      console.error(`  ERROR    ${label}\n           ${err.message}`);
      failed.push({ assetId, assetName, libraryName, error: err.message });
      appendFileSync(failedPath, JSON.stringify({ assetId, assetName, libraryName, error: err.message }) + '\n');
    }

    if (i < pending.length - 1) await sleep(DELAY_MS);
  }

  const doneTotal = completed.size + (pending.length - failed.length);

  console.log(`\n--- Summary ---`);
  console.log(`Deleted : ${doneTotal} / ${uniqueAssets.length}`);
  console.log(`Failed  : ${failed.length}`);

  if (failed.length > 0) {
    console.log(`\nFailed assets logged to ${failedPath}`);
    process.exitCode = 1;
  }

  if (doneTotal === uniqueAssets.length && existsSync(checkpointPath)) {
    console.log(`\nAll assets deleted. You can remove the checkpoint file: ${checkpointPath}`);
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
