#!/usr/bin/env node
// Sends a signed release event to HappyVertical Work so Garrula can draft a
// social post. Contract: happyvertical.com docs/work/runbook.md, "Social
// Posting Operations" (POST /api/public/release-events).
//
//   node scripts/send-work-release-event.mjs package-publish \
//     --package smrt --version 0.62.5 --repo happyvertical/smrt \
//     --release-url https://github.com/happyvertical/smrt/releases/tag/v0.62.5 \
//     [--summary TEXT] [--git-range v0.62.4..v0.62.5]
//   node scripts/send-work-release-event.mjs merged-pr --event "$GITHUB_EVENT_PATH"
//     (a `pull_request` closed event payload; ignored unless merged)
//
// Environment: WORK_RELEASE_EVENT_SECRET (required to send),
// WORK_RELEASE_EVENT_URL (optional, defaults to the production endpoint).
//
// Never fails the caller: a missing secret skips with a notice, a failed POST
// warns, and the exit code is always 0. The secret and signature are never
// printed. Dependency-free; copied verbatim into each sending repository.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_URL = 'https://work.happyvertical.com/api/public/release-events';
// Receiver limits (apps/work-web/src/lib/server/release-events.ts).
const MAX_BODY_BYTES = 28 * 1024; // receiver caps at 32 KiB
const MAX_CHANGELOG = 40;
const MAX_LINE = 1000;
const MAX_PR_URLS = 20;
const TIMEOUT_MS = 15_000;

/** `<timestamp>.<raw body>` HMAC-SHA256, hex, prefixed `v1=`. */
export function sign(secret, timestamp, rawBody) {
  return `v1=${createHmac('sha256', secret)
    .update(`${timestamp}.`, 'utf8')
    .update(rawBody)
    .digest('hex')}`;
}

/** Changelog lines and PR URLs from squash-merge subjects like `feat: x (#12)`. */
export function changelogFromSubjects(subjects, repo) {
  const changelog = [];
  const prUrls = [];
  for (const raw of subjects) {
    const line = raw.trim();
    if (!line || /^chore\(release\)/u.test(line)) continue;
    if (changelog.length < MAX_CHANGELOG) changelog.push(line.slice(0, MAX_LINE));
    const pr = line.match(/\(#(\d+)\)\s*$/u);
    if (pr && repo && prUrls.length < MAX_PR_URLS) {
      prUrls.push(`https://github.com/${repo}/pull/${pr[1]}`);
    }
  }
  return { changelog, prUrls };
}

/**
 * @param {{ pkg: string, version: string, repo?: string, releaseUrl?: string,
 *   summary?: string, subjects?: string[] }} input
 * @returns {{ package: string, version: string, changelog?: string[],
 *   prUrls?: string[], releaseUrl?: string, summary?: string, repo?: string }}
 */
export function buildPackagePublish({ pkg, version, repo, releaseUrl, summary, subjects = [] }) {
  if (!pkg || !version) throw new Error('--package and --version are required');
  const { changelog, prUrls } = changelogFromSubjects(subjects, repo);
  const body = { package: pkg, version };
  if (changelog.length) body.changelog = changelog;
  if (prUrls.length) body.prUrls = prUrls;
  if (releaseUrl) body.releaseUrl = releaseUrl;
  else if (!prUrls.length) throw new Error('--release-url is required without PR links');
  if (summary) body.summary = summary.slice(0, 2000);
  if (repo) body.repo = repo;
  // Trim the changelog until the body fits the receiver's size limit.
  while (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY_BYTES && body.changelog?.length) {
    body.changelog.pop();
  }
  return body;
}

/** `merged-pr` body from a GitHub `pull_request` event payload, or null if not merged. */
export function buildMergedPr(event) {
  const pr = event?.pull_request;
  if (!pr?.merged) return null;
  return {
    kind: 'merged-pr',
    repo: event.repository.full_name,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    mergedAt: pr.merged_at,
    labels: (pr.labels ?? []).map((label) => label.name),
  };
}

export async function send({ body, secret, url, now = Date.now(), fetchImpl = fetch }) {
  const rawBody = Buffer.from(JSON.stringify(body), 'utf8');
  const timestamp = String(Math.floor(now / 1000));
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hv-release-timestamp': timestamp,
      'x-hv-release-signature': sign(secret.trim(), timestamp, rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return response.status;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) out[arg.slice(2)] = argv[++i];
    else out._.push(arg);
  }
  return out;
}

function gitSubjects(range) {
  if (!range) return [];
  try {
    return execFileSync('git', ['log', '--no-merges', '--pretty=%s', range], {
      encoding: 'utf8',
    }).split('\n');
  } catch {
    console.log(`::warning::Could not read git range ${range}; sending without changelog.`);
    return [];
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const kind = args._[0];
  const secret = env.WORK_RELEASE_EVENT_SECRET?.trim();
  if (!secret) {
    console.log('::notice::WORK_RELEASE_EVENT_SECRET is not set; skipping Work release event.');
    return 0;
  }
  const url = env.WORK_RELEASE_EVENT_URL?.trim() || DEFAULT_URL;
  try {
    let body;
    if (kind === 'package-publish') {
      body = buildPackagePublish({
        pkg: args.package,
        version: args.version,
        repo: args.repo,
        releaseUrl: args['release-url'],
        summary: args.summary,
        subjects: gitSubjects(args['git-range']),
      });
    } else if (kind === 'merged-pr') {
      body = buildMergedPr(JSON.parse(readFileSync(args.event, 'utf8')));
      if (!body) {
        console.log('::notice::Pull request was not merged; no Work event.');
        return 0;
      }
    } else {
      throw new Error(`unsupported event kind: ${kind}`);
    }
    const status = await send({ body, secret, url });
    if (status >= 200 && status < 300) {
      console.log(`Work release event ${kind} accepted (HTTP ${status}).`);
    } else {
      console.log(`::warning::Work release event ${kind} was not accepted (HTTP ${status}).`);
    }
  } catch (error) {
    // Message only: never the request, which carries the signature.
    console.log(`::warning::Work release event ${kind} failed: ${error?.name ?? 'error'}.`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
