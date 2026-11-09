// 协议服务标识的配置映射验证（OPEN-SOURCE-ASSET-FINAL-CLOSURE-004 / B-5）
//
// 背景：两处协议常量必须与服务端返回的 service 字段一致。服务端实现未纳入本包，
// 直接改写常量会破坏协议兼容性；因此在候选副本中改为「中性默认值 + 部署方环境变量映射」。
// 本测试只验证：默认值为中性标识、映射生效、原有比对逻辑保持不变。
// 不在本文件写入任何内部项目自称字面量。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEALTH = path.join(ROOT, 'modules', 'bridge-utils', 'bridge-health.mjs');
const READY = path.join(ROOT, 'modules', 'bridge-utils', 'bridge-readiness.mjs');

function importValue(file, exportName, env = {}) {
  const code = `import { ${exportName} as v } from ${JSON.stringify(pathToFileURL(file).href)}; process.stdout.write(String(v));`;
  return execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15000,
  });
}

test('健康探针服务标识：默认值为中性标识', () => {
  assert.equal(importValue(HEALTH, 'BRIDGE_SERVICE'), 'bridge-service');
});

test('就绪快照服务标识：默认值为中性标识', () => {
  assert.equal(importValue(READY, 'READINESS_SERVICE'), 'bridge-readiness');
});

test('部署方可通过配置映射覆盖服务标识', () => {
  assert.equal(
    importValue(HEALTH, 'BRIDGE_SERVICE', { BRIDGE_SERVICE_ID: 'deployed-health-id' }),
    'deployed-health-id'
  );
  assert.equal(
    importValue(READY, 'READINESS_SERVICE', { READINESS_SERVICE_ID: 'deployed-ready-id' }),
    'deployed-ready-id'
  );
});

test('原有比对逻辑保持不变（未改写协议行为）', () => {
  const health = fs.readFileSync(HEALTH, 'utf8');
  const ready = fs.readFileSync(READY, 'utf8');
  assert.match(health, /payload\?\.service === BRIDGE_SERVICE/);
  assert.match(ready, /data\.service !== READINESS_SERVICE/);
  assert.match(health, /BRIDGE_HEALTH_PATH = '\/api\/health'/);
  assert.match(ready, /READINESS_VERSION = 1/);
});

test('公开候选源码不含内部服务自称字面量', () => {
  const health = fs.readFileSync(HEALTH, 'utf8');
  const ready = fs.readFileSync(READY, 'utf8');
  // 只检查两处常量定义行的取值来自配置映射，而非硬编码的专有服务名
  assert.match(health, /export const BRIDGE_SERVICE = process\.env\./);
  assert.match(ready, /export const READINESS_SERVICE = process\.env\./);
});
