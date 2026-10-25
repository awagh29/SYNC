#!/usr/bin/env node
// Node 22+. Read-only SpacetimeDB/file -> measured comparison table. No dependencies.
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  access,
  copyFile,
} from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL, URL } from 'node:url';
import { parseArgs } from 'node:util';
import { databaseConfig } from './lib/databaseConfig.mjs';

export const METRICS_QUERY =
  'SELECT run_id, tick, reward, net_reward, orders_received, delivered_orders, unfinished_orders, on_time_orders, late_open_orders, reported_anthropic_cost_microusd, reported_coordinator_ms, coordinator_sample_count FROM ui_metrics';
export const RUNS_QUERY =
  'SELECT id, name, seed, tick, status, mode, policy_json FROM ui_runs';

export const BEGIN = '% SYNC_BENCHMARK_TABLE_BEGIN';
export const END = '% SYNC_BENCHMARK_TABLE_END';
const POLICIES = ['FCFS', 'Claude', 'SYNC'];
const FIELDS = {
  runId: ['run_id', 'runId', 'run_key', 'experiment_id'],
  policy: [
    'policy',
    'policy_name',
    'scheduler_policy',
    'controller',
    'scheduler',
  ],
  status: ['status', 'run_status'],
  tick: ['tick', 'snapshot_tick', 'current_tick'],
  mode: ['mode', 'execution_mode'],
  terminalValue: [
    'reward',
    'completed_value',
    'terminal_value',
    'delivered_value',
    'completion_value',
  ],
  objective: [
    'net_reward',
    'objective_value',
    'objective_score',
    'net_objective',
    'objective_j_t',
  ],
  delivered: [
    'delivered_carts',
    'delivered_orders',
    'completed_carts',
    'delivered_count',
  ],
  unfinished: ['unfinished_carts', 'unfinished_orders', 'unfinished_count'],
  received: ['carts_received', 'orders_received', 'total_carts'],
  onTime: ['on_time_carts', 'on_time_orders'],
  overdueUnfinished: [
    'late_open_carts',
    'late_open_orders',
    'overdue_unfinished_carts',
  ],
  deadlineViolations: [
    'deadline_violations',
    'deadline_misses',
    'sla_violations',
  ],
  apiCost: [
    'actual_api_cost_usd',
    'anthropic_cost_usd',
    'api_cost_usd',
    'reported_anthropic_cost_microusd',
    'actual_api_cost_microusd',
    'api_cost_microusd',
  ],
  planningTime: [
    'total_planning_ms',
    'total_planning_time_ms',
    'planning_time_ms',
    'reported_coordinator_ms',
    'total_planning_micros',
    'total_planning_seconds',
  ],
  invariantViolations: ['invariant_violations', 'invariant_violation_count'],
  inputTokens: ['input_tokens'],
  outputTokens: ['output_tokens'],
  workload: ['workload_key', 'workload_id', 'scenario_id'],
  seed: ['seed', 'random_seed'],
  horizon: ['horizon_tick', 'horizon_ticks', 'horizon'],
  deadlinePenalty: ['deadline_penalty', 'deadline_penalty_score'],
  executionCost: ['actual_execution_cost_usd', 'execution_cost_usd'],
  coordinationCost: ['actual_coordination_cost_usd', 'coordination_cost_usd'],
};
const COUNT_FIELDS = new Set([
  'tick',
  'delivered',
  'unfinished',
  'received',
  'onTime',
  'overdueUnfinished',
  'deadlineViolations',
  'invariantViolations',
  'inputTokens',
  'outputTokens',
]);
const key = (s) =>
  String(s)
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
const unwrap = (v) => {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    if (Object.hasOwn(v, 'some')) return unwrap(v.some);
    if (Object.hasOwn(v, 'none')) return null;
  }
  return v;
};

// Preserve large JSON integer IDs before JSON.parse can round a u64.
export function parseJson(text) {
  let out = '',
    i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i++] === '"') break;
      }
      out += text.slice(start, i);
      continue;
    }
    if (/[-0-9]/.test(text[i])) {
      const m = text
        .slice(i)
        .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (m) {
        const n = m[0];
        out +=
          /^-?\d+$/.test(n) &&
          (BigInt(n) > BigInt(Number.MAX_SAFE_INTEGER) ||
            BigInt(n) < BigInt(Number.MIN_SAFE_INTEGER))
            ? JSON.stringify(n)
            : n;
        i += n.length;
        continue;
      }
    }
    out += text[i++];
  }
  return JSON.parse(out);
}

export function csvRows(text) {
  const grid = [];
  let row = [],
    cell = '',
    quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else if (c === undefined) throw new Error('Unclosed CSV quoted field.');
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === ',' || c === '\n' || c === undefined) {
      row.push(cell.replace(/\r$/, ''));
      cell = '';
      if (c !== ',') {
        if (row.some((v) => v !== '')) grid.push(row);
        row = [];
      }
    } else cell += c;
  }
  if (!grid.length) return [];
  const headers = grid.shift();
  if (new Set(headers).size !== headers.length)
    throw new Error('Duplicate CSV headers.');
  return grid.map((r, i) => {
    if (r.length !== headers.length)
      throw new Error(`CSV row ${i + 2} has the wrong column count.`);
    return Object.fromEntries(
      headers.map((h, j) => [h, r[j] === '' ? null : r[j]]),
    );
  });
}

export function sqlRows(result) {
  const columns = result?.schema?.elements ?? result?.schema?.Product?.elements;
  if (!Array.isArray(result?.rows))
    throw new Error('Expected a SQL result with rows.');
  return result.rows.map((row) => {
    if (!Array.isArray(row)) {
      if (row && typeof row === 'object') return row;
      throw new Error('Malformed SQL row.');
    }
    if (!columns || columns.length !== row.length)
      throw new Error('SQL row/schema column mismatch.');
    return Object.fromEntries(
      columns.map((c, i) => {
        const name = unwrap(c.name);
        if (typeof name !== 'string')
          throw new Error('SQL column name missing; alias expression columns.');
        return [name, row[i]];
      }),
    );
  });
}

export function unpack(data) {
  if (
    Array.isArray(data) &&
    data.length &&
    data[0]?.schema &&
    Array.isArray(data[0]?.rows)
  ) {
    return { metrics: sqlRows(data[0]), runs: data[1] ? sqlRows(data[1]) : [] };
  }
  if (Array.isArray(data)) return { metrics: data, runs: [] };
  if (data?.schema && data?.rows) return { metrics: sqlRows(data), runs: [] };
  if (data?.metrics) return { metrics: data.metrics, runs: data.runs ?? [] };
  if (Array.isArray(data?.rows) && data.rows.every((r) => !Array.isArray(r)))
    return { metrics: data.rows, runs: [] };
  if (data?.tables) {
    const entries = Object.entries(data.tables);
    const metrics = entries.filter(([n]) =>
      /metric|benchmark|comparison/.test(key(n)),
    );
    const runs = entries.find(([n]) =>
      /^(uiruns|syncrun|runs|run)$/.test(key(n)),
    );
    if (metrics.length === 1)
      return { metrics: metrics[0][1], runs: runs?.[1] ?? [] };
    throw new Error(
      'Export contains multiple/no metric tables. Select one as {metrics: [...], runs: [...]}.',
    );
  }
  throw new Error(
    'Expected rows, SQL JSON, CSV, or {metrics: [...], runs: [...]}.',
  );
}

function pick(row, name, config) {
  const mapped = config.fields?.[name];
  if (mapped === null) return { value: null, field: null };
  const names = mapped === undefined ? (FIELDS[name] ?? [name]) : [mapped];
  const keys = Object.keys(row);
  for (const candidate of names) {
    const field = keys.find((k) => key(k) === key(candidate));
    if (
      field !== undefined &&
      unwrap(row[field]) !== null &&
      unwrap(row[field]) !== undefined &&
      !(
        typeof unwrap(row[field]) === 'string' &&
        unwrap(row[field]).trim() === ''
      )
    )
      return { value: unwrap(row[field]), field };
  }
  return { value: null, field: null };
}

function number(value, name) {
  if (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
  )
    return null;
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new Error(`${name} is not numeric.`);
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER)
    throw new Error(`${name} is outside a safe numeric range.`);
  if (name !== 'objective' && n < 0)
    throw new Error(`${name} must not be negative.`);
  if (COUNT_FIELDS.has(name) && !Number.isInteger(n))
    throw new Error(`${name} must be an integer.`);
  return n;
}

function policyLabel(value, config) {
  if (value && typeof value === 'object') value = Object.keys(value)[0];
  if (typeof value !== 'string') return null;
  const aliases = config.policyAliases ?? {
    FCFS: ['fcfs', 'fifo', 'first_come_first_served'],
    Claude: ['claude', 'claude_scheduler', 'claude_baseline', 'llm_baseline'],
    SYNC: ['sync', 'primal_dual', 'online_primal_dual', 'sync_primal_dual'],
  };
  return (
    POLICIES.find((p) =>
      [p, ...(aliases[p] ?? [])].some((v) => key(v) === key(value)),
    ) ?? null
  );
}

function getRunId(row, config, allowId = false) {
  const id =
    pick(row, 'runId', config).value ?? (allowId ? unwrap(row.id) : null);
  if (typeof id === 'number' && !Number.isSafeInteger(id))
    throw new Error('Run ID lost precision; export IDs as strings.');
  return id === null || id === undefined ? null : String(id);
}

export function normalize(metrics, runs = [], config = {}) {
  if (!Array.isArray(metrics) || !Array.isArray(runs))
    throw new Error('Metrics and runs must be arrays.');
  const runMap = new Map();
  for (const r of runs) {
    const id = getRunId(r, config, true);
    if (id === null || runMap.has(id))
      throw new Error('Missing or duplicate run metadata ID.');
    runMap.set(id, r);
  }
  return metrics.map((metric, index) => {
    const id = getRunId(metric, config, true);
    if (id === null)
      throw new Error(
        `Metric row ${index + 1} has no run_id. Configure fields.runId.`,
      );
    const row = { ...runMap.get(id), ...metric };
    let rawPolicy = pick(row, 'policy', config).value;
    const policyJson = row.policy_json ?? row.policyJson;
    if (rawPolicy === null && policyJson) {
      const p =
        typeof policyJson === 'string' ? parseJson(policyJson) : policyJson;
      rawPolicy = p.policy ?? p.scheduler ?? p.controller;
    }
    // The feeder's Claude manager still uses primal-dual task dispatch.
    if (
      rawPolicy === 'primal_dual' &&
      /\bSYNC\s*·\s*LLM\b/i.test(row.name ?? '')
    )
      rawPolicy = 'claude';
    const result = {
      runId: id,
      policy: policyLabel(rawPolicy, config),
      rawPolicy,
      status: pick(row, 'status', config).value ?? 'unknown',
      fields: {},
      warnings: [],
    };
    result.name = row.name ?? null;
    for (const name of Object.keys(FIELDS).filter(
      (n) => !['runId', 'policy', 'status'].includes(n),
    )) {
      const chosen = pick(row, name, config);
      result.fields[name] = chosen.field;
      if (['workload', 'seed', 'horizon', 'mode'].includes(name)) {
        result[name] = chosen.value === null ? null : String(chosen.value);
        continue;
      }
      result[name] = number(chosen.value, name);
    }
    if (
      result.unfinished === null &&
      result.received !== null &&
      result.delivered !== null
    )
      result.unfinished = result.received - result.delivered;
    if (
      result.deadlineViolations === null &&
      result.delivered !== null &&
      result.onTime !== null &&
      result.overdueUnfinished !== null
    )
      result.deadlineViolations =
        result.delivered - result.onTime + result.overdueUnfinished;
    if (
      (result.unfinished ?? 0) < 0 ||
      (result.deadlineViolations ?? 0) < 0 ||
      (result.onTime !== null &&
        result.delivered !== null &&
        result.onTime > result.delivered)
    )
      throw new Error(`Inconsistent counts in run ${id}.`);
    if (
      [result.received, result.delivered, result.unfinished].every(
        (v) => v !== null,
      ) &&
      result.received !== result.delivered + result.unfinished
    )
      throw new Error(
        `Received/delivered/unfinished counts do not reconcile in run ${id}.`,
      );
    if (result.apiCost !== null) {
      const unit =
        config.units?.apiCost ??
        (/microusd/i.test(result.fields.apiCost) ? 'microusd' : 'usd');
      if (!['usd', 'microusd'].includes(unit))
        throw new Error('units.apiCost must be usd or microusd.');
      if (unit === 'microusd') result.apiCost /= 1e6;
    }
    if (result.planningTime !== null) {
      const field = result.fields.planningTime ?? '';
      const unit =
        config.units?.planningTime ??
        (/micros/i.test(field) ? 'us' : /seconds/i.test(field) ? 's' : 'ms');
      if (!['ms', 'us', 's'].includes(unit))
        throw new Error('units.planningTime must be ms, us, or s.');
      result.planningTime *= unit === 'us' ? 0.001 : unit === 's' ? 1000 : 1;
    }
    if (result.objective === null && config.objectiveWeights) {
      const w = config.objectiveWeights;
      if (
        ['beta', 'gamma', 'delta'].every(
          (k) => typeof w[k] === 'number' && Number.isFinite(w[k]) && w[k] >= 0,
        ) &&
        [
          result.terminalValue,
          result.deadlinePenalty,
          result.executionCost,
          result.coordinationCost,
        ].every((v) => v !== null)
      ) {
        result.objective =
          result.terminalValue -
          w.beta * result.deadlinePenalty -
          w.gamma * result.executionCost -
          w.delta * result.coordinationCost;
        result.fields.objective =
          'computed from supplied objectiveWeights and measured components';
      } else
        result.warnings.push(
          'Objective unavailable: explicit weights and all four measured components are required.',
        );
    }
    if (result.apiCost !== null)
      result.warnings.push(
        'API cost is the recorded amount; usage completeness is not independently verified.',
      );
    if (key(result.fields.planningTime ?? '') === 'reportedcoordinatorms')
      result.warnings.push(
        'Planning time is reported coordinator time only; total algorithm/optimizer time is not exposed by ui_metrics.',
      );
    if (result.invariantViolations === null)
      result.warnings.push(
        'Invariant violations are not exposed by ui_metrics; unavailable does not mean zero.',
      );
    if (key(result.fields.objective ?? '') === 'netreward')
      result.warnings.push(
        'Objective uses the current evaluateRun net_reward, including its configured penalties; verify these weights against the paper.',
      );
    if (result.policy === 'Claude' && rawPolicy === 'claude')
      result.warnings.push(
        'Claude denotes the LLM staffing manager with primal-dual task dispatch, not a standalone Claude scheduler.',
      );
    return result;
  });
}

export function selectRuns(
  records,
  { runIds = {}, includeRunning = false } = {},
) {
  const result = {},
    warnings = [];
  for (const p of POLICIES) {
    const rows = records.filter(
      (r) =>
        r.policy === p &&
        (includeRunning ||
          !['running', 'paused', 'active', 'created', 'starting'].includes(
            String(r.status).toLowerCase(),
          )),
    );
    const byRun = new Map();
    for (const r of rows) {
      const old = byRun.get(r.runId);
      if (!old || (r.tick ?? -1) > (old.tick ?? -1)) byRun.set(r.runId, r);
      else if (
        (r.tick ?? -1) === (old.tick ?? -1) &&
        JSON.stringify(r) !== JSON.stringify(old)
      )
        throw new Error(
          `Conflicting snapshots for ${p} run ${r.runId}; supply one final snapshot.`,
        );
    }
    const requested = runIds[p];
    if (requested !== undefined) {
      if (!byRun.has(String(requested)))
        throw new Error(
          `Requested ${p} run ${requested} is missing or still running.`,
        );
      result[p] = byRun.get(String(requested));
    } else if (byRun.size > 1) {
      throw new Error(
        `Multiple ${p} runs (${[...byRun.keys()].join(', ')}). Select with --run-ids "${p}=RUN_ID,...".`,
      );
    } else result[p] = [...byRun.values()][0] ?? null;
    if (!result[p])
      warnings.push(`${p}: no selected result; its cells remain unavailable.`);
    else if (String(result[p].status).toLowerCase() === 'unknown')
      warnings.push(`${p}: run completion status is not recorded.`);
  }
  if (!POLICIES.some((p) => result[p]))
    throw new Error(
      'No FCFS/Claude/SYNC results found. Check policyAliases, run status, and field mappings.',
    );
  const selected = Object.values(result).filter(Boolean);
  for (const f of ['workload', 'seed', 'horizon', 'mode']) {
    const values = selected.map((r) => r[f]);
    if (values.some((v) => v === null) || new Set(values).size !== 1)
      warnings.push(
        `Matched ${f} is unverified or differs across selected runs.`,
      );
  }
  if (
    selected.some((r) =>
      /pseudo|simulat|fixture|deterministic/i.test(r.mode ?? ''),
    )
  )
    warnings.push(
      'A selected run uses simulated/fixture execution. Its costs and outcomes are not a live-agent comparison.',
    );
  warnings.push(
    'Check outcome grain (cart versus item), initial resources, staffing permissions, and objective weights before claiming a matched comparison.',
  );
  warnings.push(
    'Only explicitly selected run snapshots are compared; no winner or statistical significance is inferred.',
  );
  return {
    policies: result,
    warnings: [
      ...new Set([...warnings, ...selected.flatMap((r) => r.warnings)]),
    ],
  };
}

function fmt(n, digits = 3) {
  return n === null || n === undefined
    ? '\\NA'
    : n.toLocaleString('en-US', {
        maximumFractionDigits: digits,
        useGrouping: false,
      });
}
export function printComparison(summary) {
  const rows = [
    ['Run ID', (r) => r.runId],
    ['Terminal value (cart reward)', (r) => fmt(r.terminalValue)],
    ['Objective J_T (net reward)', (r) => fmt(r.objective)],
    [
      'Delivered / unfinished (items)',
      (r) => `${fmt(r.delivered)} / ${fmt(r.unfinished)}`,
    ],
    ['Deadline violations (items)', (r) => fmt(r.deadlineViolations)],
    ['API cost (USD)', (r) => fmt(r.apiCost, 6)],
    ['Planning time (reported coordinator ms)', (r) => fmt(r.planningTime)],
    ['Invariant violations', (r) => fmt(r.invariantViolations)],
  ];
  console.table(
    rows.map(([Metric, read]) => ({
      Metric,
      ...Object.fromEntries(
        POLICIES.map((p) => [
          p,
          summary.policies[p]
            ? String(read(summary.policies[p])).replaceAll('\\NA', '—')
            : '—',
        ]),
      ),
    })),
  );
}
export function renderTable(summary) {
  const rows = [
    ['Terminal value', (r) => fmt(r.terminalValue)],
    ['Objective $J_T$', (r) => fmt(r.objective)],
    [
      'Delivered / unfinished',
      (r) => `${fmt(r.delivered)} / ${fmt(r.unfinished)}`,
    ],
    ['Deadline violations', (r) => fmt(r.deadlineViolations)],
    [
      'API cost (USD)',
      (r) =>
        r.apiCost !== null && r.apiCost > 0 && r.apiCost < 1e-6
          ? '$<0.000001$'
          : fmt(r.apiCost, 6),
    ],
    ['Reported coordinator time (ms)', (r) => fmt(r.planningTime)],
    ['Invariant violations', (r) => fmt(r.invariantViolations)],
  ];
  return [
    BEGIN,
    '\\begin{table}[htbp]',
    '\\centering',
    '\\begin{tabular}{@{}lccc@{}}',
    '\\toprule',
    'Metric & FCFS & Claude & SYNC \\\\',
    '\\midrule',
    ...rows.map(
      ([label, f]) =>
        `${label} & ${POLICIES.map((p) => (summary.policies[p] ? f(summary.policies[p]) : '\\NA')).join(' & ')} \\\\`,
    ),
    '\\bottomrule',
    '\\end{tabular}',
    '\\caption{Recorded FCFS, Claude, and SYNC run snapshots. Dashes denote',
    'unavailable measurements, not zeros. API costs are as recorded; matched',
    'workloads and usage completeness require verification. Run identifiers,',
    'field provenance, and export warnings are retained in the companion JSON.}',
    '\\label{tab:benchmark-results}',
    '\\end{table}',
    END,
    '',
  ].join('\n');
}

export function replaceTable(document, table) {
  if (document.split(BEGIN).length !== 2 || document.split(END).length !== 2)
    throw new Error(
      'Document must contain exactly one SYNC benchmark marker pair; use the included updated document.',
    );
  const start = document.indexOf(BEGIN),
    end = document.indexOf(END);
  if (end < start) throw new Error('Benchmark markers are reversed.');
  return (
    document.slice(0, start) +
    table.trimEnd() +
    document.slice(end + END.length)
  );
}

export function safeQuery(q) {
  q = q.trim().replace(/;\s*$/, '');
  if (!/^SELECT\s/i.test(q) || /;|--|\/\*/.test(q))
    throw new Error(
      'Only one read-only SELECT statement is allowed per query.',
    );
  return q;
}

export function client(server, database, token, fetcher = fetch) {
  const base = new URL(
    server.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'),
  );
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw new Error(
      'Server must be an HTTP(S)/WS(S) URL without credentials, query, or fragment.',
    );
  const prefix =
    base.href.replace(/\/$/, '') +
    '/v1/database/' +
    encodeURIComponent(database);
  async function request(path, body) {
    const headers = {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    if (body !== undefined) headers['Content-Type'] = 'text/plain';
    const response = await fetcher(prefix + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw new Error(
        `SpacetimeDB HTTP ${response.status}. Check the server/database, query names, and identity permissions. Tokens are read from the environment only.`,
      );
    return parseJson(await response.text());
  }
  return {
    schema: () => request('/schema?version=9'),
    query: async (q) => {
      const data = await request('/sql', safeQuery(q));
      if (!Array.isArray(data) || data.length !== 1)
        throw new Error('Expected one SQL statement result.');
      return sqlRows(data[0]);
    },
  };
}

const HELP = `SYNC benchmark exporter (Node 22+; no npm install required)

Live database:
  node scripts/export-benchmark.mjs --server https://SERVER --database DATABASE --document docs/SYNC_Complete_Formulation_and_Solution.tex
Existing export:
  node scripts/export-benchmark.mjs --input results.json --document docs/SYNC_Complete_Formulation_and_Solution.tex
Inspect names first:
  node scripts/export-benchmark.mjs --server https://SERVER --database DATABASE --discover

Options:
  --input FILE             JSON/CSV rows, SQL JSON, or {metrics: [...], runs: [...]}
  --runs-input FILE        Optional separate run metadata JSON/CSV
  --config FILE            JSON query/field/unit/policy mappings (see example)
  --metrics-query SQL      Default: SELECT * FROM ui_metrics
  --runs-query SQL         Default: SELECT * FROM ui_runs
  --run-ids LIST           FCFS=ID,Claude=ID,SYNC=ID (avoids cherry-picking automatically)
  --include-running       Explicitly allow active snapshots
  --token-file FILE       Read an authorized database identity token from FILE
  --list-runs             Print available run IDs and names
  --all                   Print every eligible snapshot separately
  --console-only          Print comparison without writing export files
  --out DIR               Output directory (default docs/benchmark)
  --document FILE         Replace the marked table; keep FILE.bak on first update
  --discover              Print schema table/view names, without selecting data
  --help                  Show this message

Environment: SPACETIMEDB_URI / VITE_SPACETIMEDB_URI, SPACETIMEDB_DATABASE /
VITE_SPACETIMEDB_MODULE_NAME, SPACETIMEDB_TOKEN. For an env file use Node's
--env-file=.env before the script name. Never put a private token in a VITE variable.
No publishing, reducers, migrations, or API agent calls are performed.
Missing measurements remain dashes; modeled costs are never relabeled actual API costs.
`;

async function readInput(file) {
  const text = await readFile(file, 'utf8');
  return file.toLowerCase().endsWith('.csv') ? csvRows(text) : parseJson(text);
}
async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temp = path + `.tmp-${process.pid}`;
  await writeFile(temp, content);
  await rename(temp, path);
}

export async function main(argv = process.argv.slice(2)) {
  const { values: args } = parseArgs({
    args: argv,
    options: Object.fromEntries(
      [
        'server',
        'database',
        'input',
        'runs-input',
        'config',
        'metrics-query',
        'runs-query',
        'run-ids',
        'out',
        'document',
        'token-file',
      ]
        .map((n) => [n, { type: 'string' }])
        .concat([
          ['help', { type: 'boolean' }],
          ['discover', { type: 'boolean' }],
          ['include-running', { type: 'boolean' }],
          ['console-only', { type: 'boolean' }],
          ['list-runs', { type: 'boolean' }],
          ['all', { type: 'boolean' }],
        ]),
    ),
  });
  if (args.help) {
    console.log(HELP);
    return;
  }
  const config = args.config
    ? parseJson(await readFile(args.config, 'utf8'))
    : {};
  let data, source;
  if (args.input) {
    data = unpack(await readInput(args.input));
    source = { kind: 'file', file: resolve(args.input) };
  } else {
    const defaults = databaseConfig();
    const server =
      args.server ??
      process.env.SPACETIMEDB_URI ??
      process.env.SPACETIMEDB_SERVER ??
      process.env.VITE_SPACETIMEDB_URI ??
      defaults.uri;
    const database =
      args.database ??
      process.env.SPACETIMEDB_DATABASE ??
      process.env.VITE_SPACETIMEDB_DATABASE ??
      process.env.SPACETIMEDB_MODULE_NAME ??
      process.env.VITE_SPACETIMEDB_MODULE_NAME ??
      defaults.database;
    if (!server || !database)
      throw new Error(
        'Supply --server and --database, their environment variables, or --input. Use --help for examples.',
      );
    const token = args['token-file']
      ? (await readFile(args['token-file'], 'utf8')).trim()
      : (process.env.SPACETIMEDB_TOKEN ?? process.env.SPACETIME_TOKEN);
    const db = client(server, database, token);
    if (args.discover) {
      const schema = await db.schema();
      console.log(
        JSON.stringify(
          {
            tables: schema.tables?.map((t) => ({
              name: t.name,
              access: t.table_access,
            })),
            views: schema.views?.map((v) => ({ name: v.name })),
            note: 'Use the actual metrics/run names in --config or SQL flags.',
          },
          null,
          2,
        ),
      );
      return;
    }
    const metricsQuery =
      args['metrics-query'] ?? config.metricsQuery ?? METRICS_QUERY;
    const runsQuery = args['runs-query'] ?? config.runsQuery ?? RUNS_QUERY;
    if (args['list-runs']) {
      console.table(
        (await db.query(runsQuery)).map(
          ({ id, name, seed, tick, status, mode }) => ({
            id,
            name,
            seed,
            tick,
            status,
            mode,
          }),
        ),
      );
      return;
    }
    const metrics = await db.query(metricsQuery);
    let runs = [];
    if (runsQuery)
      try {
        runs = await db.query(runsQuery);
      } catch {
        console.warn(
          'Run metadata query unavailable. Configure --runs-query or use --runs-input; policy/status must otherwise exist on metric rows.',
        );
      }
    data = { metrics, runs };
    source = { kind: 'spacetimedb', server, database, metricsQuery, runsQuery };
  }
  if (args['runs-input']) {
    const raw = await readInput(args['runs-input']);
    data.runs =
      Array.isArray(raw) && raw[0]?.schema
        ? sqlRows(raw[0])
        : Array.isArray(raw)
          ? raw
          : (raw.runs ?? unpack(raw).metrics);
  }
  const runIds = { ...config.runIds };
  if (args['run-ids'])
    for (const pair of args['run-ids'].split(',')) {
      const [name, ...parts] = pair.split('='),
        p = POLICIES.find((p) => key(p) === key(name));
      if (!p || !parts.join('='))
        throw new Error('--run-ids requires FCFS=ID,Claude=ID,SYNC=ID.');
      runIds[p] = parts.join('=');
    }
  const records = normalize(data.metrics, data.runs, config);
  if (args.all) {
    const eligible = records.filter(
      (r) => r.policy && (args['include-running'] || r.status === 'completed'),
    );
    if (!eligible.length)
      throw new Error('No eligible snapshots visible to this identity.');
    console.table(
      eligible.map((r) => ({
        run: r.runId,
        name: r.name,
        policy: r.policy,
        tick: r.tick,
        status: r.status,
        terminalValue: r.terminalValue,
        objective: r.objective,
        'delivered / unfinished (items)': `${r.delivered ?? '—'} / ${r.unfinished ?? '—'}`,
        deadlineViolations: r.deadlineViolations,
        apiCostUSD: r.apiCost,
        reportedCoordinatorMs: r.planningTime,
        invariantViolations: r.invariantViolations ?? '—',
      })),
    );
    for (const warning of new Set(eligible.flatMap((r) => r.warnings)))
      console.warn(`Note: ${warning}`);
    console.warn(
      'Each row is a separate snapshot, not a matched or aggregated comparison. Execution mode and scenario versions may differ.',
    );
    return;
  }
  const summary = {
    exportedAt: new Date().toISOString(),
    source,
    ...selectRuns(records, {
      runIds,
      includeRunning: args['include-running'] ?? false,
    }),
  };
  printComparison(summary);
  if (args['console-only']) {
    for (const warning of summary.warnings) console.warn(`Note: ${warning}`);
    return;
  }
  const table = renderTable(summary),
    out = resolve(args.out ?? 'docs/benchmark');
  let updated;
  if (args.document)
    updated = replaceTable(await readFile(args.document, 'utf8'), table);
  await atomicWrite(join(out, 'benchmark-table.tex'), table);
  await atomicWrite(
    join(out, 'benchmark-summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  if (args.document) {
    const target = resolve(args.document);
    try {
      await access(target + '.bak');
    } catch {
      await copyFile(target, target + '.bak');
    }
    await atomicWrite(target, updated);
  }
  console.log(
    `Exported measured table to ${join(out, 'benchmark-table.tex')}.`,
  );
  if (args.document)
    console.log(
      `Updated ${resolve(args.document)}; first version retained as .bak.`,
    );
  for (const warning of summary.warnings) console.warn(`Note: ${warning}`);
  console.log(
    'No database rows were modified. No benchmark values were fabricated.',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(`Benchmark export failed: ${error.message}`);
    process.exitCode = 1;
  });
