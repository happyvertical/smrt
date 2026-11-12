#!/usr/bin/env node
// A stand-in for `claude` / `codex` for tests: no network, no model. It reads
// the "prompt" from stdin and acts on its first line, emitting the same JSON
// stream shapes the real tools do:
//
//   say <text>                 stream <text>, finish
//   tool <name> <json args>    call the shell's /mcp route like a real client
//                              (URL from the mcp config / -c override, bearer
//                              from SMRT_SHELL_MCP_TOKEN), report the result
//   dump                       write argv + env names to <cwd>/../dump.json
//   hang                       start a grandchild, write pids, never finish
//   forbidden                  emit a tool_use of a built-in tool
//   fail                       exit 1 with noise on stderr
//   resume                     say whether it was resumed and with which id
import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--help')) process.exit(0);
const isCodex = argv[0] === 'exec';
const prompt = readFileSync(0, 'utf8');
const [head, ...rest] = prompt.split('\n')[0].split(' ');
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sessionOf = () => {
  // codex: `exec resume <options> <id> -`; claude: `--resume <id>`
  if (isCodex && argv[1] === 'resume')
    return { resumed: true, id: argv[argv.length - 2] };
  const i = argv.indexOf('--resume');
  if (i >= 0) return { resumed: true, id: argv[i + 1] };
  const j = argv.indexOf('--session-id');
  return { resumed: false, id: j >= 0 ? argv[j + 1] : 'codex-thread-1' };
};
const session = sessionOf();
const sibling = (name) => join(dirname(process.cwd()), name);

function start() {
  if (isCodex) {
    out({ type: 'thread.started', thread_id: session.id });
    out({ type: 'turn.started' });
  } else {
    out({ type: 'system', subtype: 'init', session_id: session.id, tools: [] });
  }
}

function say(text) {
  if (isCodex) {
    out({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text } });
    out({ type: 'turn.completed', usage: {} });
    return;
  }
  const half = Math.ceil(text.length / 2);
  out({ type: 'stream_event', event: { type: 'message_start' } });
  for (const part of [text.slice(0, half), text.slice(half)])
    out({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } },
    });
  out({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
  out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session.id });
}

function mcpUrl() {
  if (isCodex) {
    const arg = argv.find((a) => a.startsWith('mcp_servers.smrt.url='));
    return JSON.parse(arg.slice('mcp_servers.smrt.url='.length));
  }
  const file = argv[argv.indexOf('--mcp-config') + 1];
  return JSON.parse(readFileSync(file, 'utf8')).mcpServers.smrt.url;
}

async function callTool(name, args) {
  const response = await fetch(mcpUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${process.env.SMRT_SHELL_MCP_TOKEN}`,
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'stub', version: '0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const text = await response.text();
  const data = text.startsWith('{')
    ? text
    : (text.split('\n').find((l) => l.startsWith('data:')) ?? 'data: {}').slice(5);
  const body = JSON.parse(data);
  return { status: response.status, body };
}

start();
if (head === 'say') {
  say(rest.join(' '));
} else if (head === 'context') {
  say(JSON.stringify({ prompt, resumed: session.resumed }));
} else if (head === 'resume') {
  say(`${session.resumed ? 'resumed' : 'new'}:${session.id}`);
} else if (head === 'tool') {
  const [name, ...json] = rest;
  const args = json.length ? JSON.parse(json.join(' ')) : {};
  const id = 'toolu_1';
  if (isCodex) {
    out({ type: 'item.started', item: { id, type: 'mcp_tool_call', server: 'smrt', tool: name, arguments: args, status: 'in_progress' } });
  } else {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: `mcp__smrt__${name}`, input: args }] } });
  }
  const { status, body } = await callTool(name, args);
  const result = body.result ?? {};
  const text = (result.content ?? []).map((c) => c.text ?? '').join('\n') || JSON.stringify(body);
  const ok = status === 200 && !body.error && result.isError !== true;
  if (isCodex) {
    out({ type: 'item.completed', item: { id, type: 'mcp_tool_call', server: 'smrt', tool: name, arguments: args, result: { content: [{ type: 'text', text }] }, status: ok ? 'completed' : 'failed' } });
  } else {
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: !ok }] } });
  }
  say('All done.');
} else if (head === 'dump') {
  writeFileSync(
    sibling('dump.json'),
    JSON.stringify({ argv, env: process.env, cwd: process.cwd() }),
  );
  say('dumped');
} else if (head === 'hang' || head === 'hang-text') {
  const grand = spawn('sleep', ['300'], { stdio: 'ignore' });
  // Hosts use existence as readiness: publish the complete snapshot atomically.
  const snapshot = sibling('pids.json');
  writeFileSync(`${snapshot}.tmp`, JSON.stringify({ child: process.pid, grand: grand.pid }));
  renameSync(`${snapshot}.tmp`, snapshot);
  if (head === 'hang-text') say('callback trigger');
  setInterval(() => {}, 1000);
} else if (head === 'structured') {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'result', name: 'StructuredOutput', input: { raw: 'raw-payload' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'result', content: 'raw-payload' }] } });
  out({ type: 'result', subtype: 'success', structured_output: { ok: true } });
} else if (head === 'blocked-name') {
  const name = JSON.parse(rest.join(' '));
  if (isCodex) out({ type: 'item.started', item: { id: 'x', type: 'mcp_tool_call', server: 'smrt', tool: name, arguments: { secret: 'raw-payload' } } });
  else out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name, input: { secret: 'raw-payload' } }] } });
  setInterval(() => {}, 1000);
} else if (head === 'forbidden') {
  if (isCodex) out({ type: 'item.completed', item: { id: 'x', type: 'command_execution', command: 'ls' } });
  else out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }] } });
  setInterval(() => {}, 1000);
} else if (head === 'fail') {
  process.stderr.write('boom secret-in-stderr\n');
  process.exit(1);
} else if (head === 'host-disabled') {
  out({ type: 'item.completed', item: { type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled. secret-in-host-error' } });
  say('This answer must never be published.');
  setInterval(() => {}, 1000);
} else if (head === 'mcp-fail') {
  process.stderr.write('MCP startup failed: secret-in-stderr\n');
  process.exit(1);
} else {
  say(`unknown command ${head}`);
}
