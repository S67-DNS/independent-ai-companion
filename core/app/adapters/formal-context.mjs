import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function readSessionHeader(file) {
  const text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
  return JSON.parse(text.split(/\r?\n/)[0]);
}

export function loadFormalContext(config) {
  const f = config.formal;
  const manifest = readJson(f.sessionManifest);
  const header = readSessionHeader(f.sessionBackup);
  const sessions = readJson(f.sessions);
  const currentRole = readJson(f.currentRole);
  const mode = readJson(f.mode);
  const roleText = fs.readFileSync(f.role, 'utf8');
  const checks = {
    manifestSessionMatchesHeader: manifest.sessionId === header.id,
    manifestWorkspaceMatchesHeader: manifest.workspace === header.cwd,
    manifestPresetMatchesHeader: manifest.preset === header.agentPreset,
    manifestOwnerIsAdmin: manifest.owner === `private:${config.expected.ownerQQ}`,
    manifestRoleIsCORE_ENTITY: manifest.role === config.expected.role,
    sessionsOwnerMapsToSession: sessions.sessions?.[`private:${config.expected.ownerQQ}`] === manifest.sessionId,
    currentRoleIsCORE_ENTITY: currentRole.role === config.expected.role,
    modeIsReserved2: mode.mode === 'reserved2',
    roleTextNonEmpty: roleText.trim().length > 0,
  };
  return {
    manifest: {
      sessionId: manifest.sessionId,
      workspace: manifest.workspace,
      role: manifest.role,
      preset: manifest.preset,
      owner: manifest.owner,
      ownerType: manifest.ownerType,
      verifiedAt: manifest.verifiedAt,
      sha256: sha256(f.sessionManifest),
    },
    header,
    headerSha256: crypto.createHash('sha256').update(JSON.stringify(header)).digest('hex'),
    sessionBackupSha256: sha256(f.sessionBackup),
    sessionsSha256: sha256(f.sessions),
    currentRoleSha256: sha256(f.currentRole),
    modeSha256: sha256(f.mode),
    roleSha256: sha256(f.role),
    roleChars: roleText.length,
    checks,
    allChecksPass: Object.values(checks).every(Boolean),
  };
}
