/**
 * 初始化演示数据库：用户 + 快照 + 每个模型的基线运行 + 一个口径修订版本。
 */
import { resetDb } from './db.js';
import { bootstrap, createSnapshot, createRun } from './index.js';
import { buildSeedDataset } from './seed-data.js';

resetDb();
bootstrap();

const payload = buildSeedDataset();
const snap = createSnapshot({
  payload,
  name: payload.name,
  description: payload.description,
  source: 'seed',
  createdBy: 'u_admin',
});

const runs = {};
for (const model of ['last_touch', 'linear', 'time_decay']) {
  const created = createRun({
    snapshotId: snap.id,
    modelId: model,
    modelVersion: '1.0.0',
    params: {},
    refundPolicy: 'clawback',
    label: `${model} 基线`,
    createdBy: 'u_admin',
  });
  runs[model] = created.id;
}

// 末次触点的口径修订版：直接访问回退。旧结果保留，只新增结果。
const lt11 = createRun({
  snapshotId: snap.id,
  modelId: 'last_touch',
  modelVersion: '1.1.0',
  params: {},
  refundPolicy: 'clawback',
  label: '末次触点 v1.1.0（直访回退）',
  createdBy: 'u_admin',
  supersedes: runs.last_touch,
});

console.log(JSON.stringify({ snapshot: snap.id, runs, last_touch_1_1: lt11.id }, null, 2));
