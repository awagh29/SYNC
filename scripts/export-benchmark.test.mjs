import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize,
  selectRuns,
  parseJson,
  sqlRows,
  METRICS_QUERY,
  RUNS_QUERY,
  client,
} from './export-benchmark.mjs';

const run = {
  id: '9007199254740993',
  name: 'Mid-3 · SYNC · LLM [batch]',
  status: 'completed',
  policy_json: '{"policy":"primal_dual"}',
};
const metric = {
  run_id: run.id,
  tick: 154,
  reward: 32,
  completed_value: 999,
  net_reward: -1.5,
  orders_received: 32,
  delivered_orders: 30,
  unfinished_orders: 2,
  on_time_orders: 28,
  late_open_orders: 1,
  reported_anthropic_cost_microusd: '1234567',
  reported_coordinator_ms: 123.5,
};

test('current SQL schema maps cart reward, objective, item deadlines and cost units', () => {
  const [r] = normalize([metric], [run]);
  assert.equal(r.policy, 'Claude');
  assert.equal(r.runId, run.id);
  assert.equal(r.terminalValue, 32);
  assert.equal(r.objective, -1.5);
  assert.equal(r.deadlineViolations, 3);
  assert.equal(r.apiCost, 1.234567);
  assert.equal(r.planningTime, 123.5);
  assert.equal(r.invariantViolations, null);
  assert.ok(r.warnings.some((w) => w.includes('coordinator time only')));
});

test('SDK camelCase exports give the same metrics; LLM baseline remains FCFS', () => {
  const camel = Object.fromEntries(
    Object.entries(metric).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c) => c.toUpperCase()),
      v,
    ]),
  );
  const [r] = normalize(
    [camel],
    [
      {
        ...run,
        policy_json: undefined,
        policyJson: '{"policy":"fcfs"}',
        name: 'Mid-3 · Baseline · LLM [batch]',
      },
    ],
  );
  assert.equal(r.policy, 'FCFS');
  assert.equal(r.objective, -1.5);
  assert.equal(r.apiCost, 1.234567);
});

test('large SQL IDs survive parsing and ambiguous comparisons require selection', () => {
  const response = parseJson(
    '{"schema":{"elements":[{"name":{"some":"run_id"}}]},"rows":[[9007199254740993]]}',
  );
  assert.equal(sqlRows(response)[0].run_id, run.id);
  const records = normalize(
    [metric, { ...metric, run_id: '2' }],
    [run, { ...run, id: '2' }],
  );
  assert.throws(() => selectRuns(records), /Multiple Claude runs/);
  assert.equal(
    selectRuns(records, { runIds: { Claude: run.id } }).policies.Claude.runId,
    run.id,
  );
});

test('queries use current view columns through read-only HTTP SQL', async () => {
  const requests = [];
  const db = client(
    'wss://example.com',
    'sync',
    undefined,
    async (url, options) => {
      requests.push({ url, ...options });
      return {
        ok: true,
        text: async () => '[{"schema":{"elements":[]},"rows":[]}]',
      };
    },
  );
  await db.query(METRICS_QUERY);
  await db.query(RUNS_QUERY);
  assert.match(requests[0].body, /reward, net_reward/);
  assert.match(requests[1].body, /policy_json/);
  assert.equal(requests[0].url, 'https://example.com/v1/database/sync/sql');
  await assert.rejects(() => db.query('DELETE FROM run'), /read-only SELECT/);
});
