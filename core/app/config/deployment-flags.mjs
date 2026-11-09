import fs from 'node:fs';
import path from 'node:path';

export const DEPLOYMENT_FLAG_KEYS = ['diveEnabled', 'proactiveEnabled'];

function asBool(value) {
  return value === true || value === 'true' || value === 1;
}

/**
 * 单向兼容读：
 * - 任意新字段存在 ⇒ 只用新字段，旧 autonomousScheduler 一律忽略；
 * - 两个新字段都不存在 ⇒ 才用旧开关一次性推导（ENABLED→true，DISABLED→false）。
 */
export function resolveDeploymentFlags(config = {}) {
  const d = config?.deployment ?? {};
  const hasNew = d.diveEnabled !== undefined || d.proactiveEnabled !== undefined;
  if (hasNew) {
    return { diveEnabled: asBool(d.diveEnabled), proactiveEnabled: asBool(d.proactiveEnabled) };
  }
  const legacy = d.autonomousScheduler === 'ENABLED';
  return { diveEnabled: legacy, proactiveEnabled: legacy };
}

/**
 * 把两个新开关写回真实配置文件；写入只包含两个新字段，并删除旧字段。
 * 调用方显式传 flags 时，旧字段绝不会覆盖它。
 */
export function persistDeploymentFlags(configPath, config, flags) {
  const abs = path.resolve(configPath);
  const next = JSON.parse(JSON.stringify(config));
  next.deployment = next.deployment && typeof next.deployment === 'object' ? next.deployment : {};
  const before = JSON.stringify({
    dive: next.deployment.diveEnabled,
    proactive: next.deployment.proactiveEnabled,
    legacy: next.deployment.autonomousScheduler,
  });
  next.deployment.diveEnabled = flags?.diveEnabled === true;
  next.deployment.proactiveEnabled = flags?.proactiveEnabled === true;
  delete next.deployment.autonomousScheduler;
  const after = JSON.stringify({
    dive: next.deployment.diveEnabled,
    proactive: next.deployment.proactiveEnabled,
    legacy: next.deployment.autonomousScheduler,
  });
  if (before === after) return { config: next, flags: resolveDeploymentFlags(next), changed: false, configPath: abs };
  const dir = path.dirname(abs);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, abs);
  return { config: next, flags: resolveDeploymentFlags(next), changed: true, configPath: abs };
}

/**
 * 启动迁移：
 * - 没有新字段：从旧字段一次性推导并落盘，删除旧字段；
 * - 只有一个新字段：存在新字段即权威，缺失的新字段按 false 落盘，旧字段忽略并删除；
 * - 两个新字段都存在：只读，不再重新推导（旧字段若还在也不会被使用）。
 */
export function ensureDeploymentFlagsPersisted(configPath, config) {
  const abs = path.resolve(configPath);
  const d = config?.deployment ?? {};
  const hasNew = d.diveEnabled !== undefined || d.proactiveEnabled !== undefined;
  const bothNew = d.diveEnabled !== undefined && d.proactiveEnabled !== undefined;
  const flags = resolveDeploymentFlags(config);
  if (bothNew) {
    if (d.autonomousScheduler === undefined) return { config, flags, changed: false, configPath: abs };
    // 新字段已齐：不再推导/覆盖，只清理遗留旧字段，保证后续启动只有一个权威来源。
    return persistDeploymentFlags(abs, config, flags);
  }
  if (!hasNew) return persistDeploymentFlags(abs, config, flags);
  return persistDeploymentFlags(abs, config, flags);
}
