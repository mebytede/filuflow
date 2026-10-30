// scripts/install.sh in dry-run mode: generates the configuration files into a temporary directory without root,
// network, package installation or services. Checks contents, file modes and that secrets only end up in the env file.
// The latest release is injected with FILUFLOW_INSTALL_LATEST_VERSION (default 9.8.7), so no git lookup happens.
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = resolve(import.meta.dirname, '..', 'scripts', 'install.sh');
const LATEST = '9.8.7';
const RELEASE_IMAGE = 'ghcr.io/mebytede/filuflow';
const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'filuflow-install-'));
  dirs.push(dir);
  return join(dir, 'opt-filuflow');
}

/** Environment without FILUFLOW_* variables (the script takes secrets from them) */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!key.startsWith('FILUFLOW_')) env[key] = value;
  return { ...env, ...extra };
}

function install(args: string[], extraEnv: Record<string, string> = {}) {
  const env = cleanEnv({ FILUFLOW_INSTALL_LATEST_VERSION: LATEST, ...extraEnv });
  const result = spawnSync('bash', [SCRIPT, '--dry-run', '--yes', ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: result.stdout + result.stderr };
}

function parseEnv(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^'(.*)'$/, '$1');
  }
  return values;
}

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

function filesIn(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** Secrets appear only in the env file and exactly once in the output (the summary at the end) */
function expectSecretsOnlyInEnv(dir: string, envFile: string, secrets: string[], output: string) {
  for (const secret of secrets) {
    expect(secret.length).toBeGreaterThanOrEqual(16);
    for (const file of filesIn(dir)) {
      if (file === envFile) continue;
      expect(readFileSync(file, 'utf8'), `${secret.slice(0, 6)}... in ${file}`).not.toContain(secret);
    }
    expect(count(output, secret)).toBe(1);
  }
}

describe('install.sh', () => {
  it('is valid bash', () => {
    const result = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  const shellcheck = spawnSync('shellcheck', ['--version'], { encoding: 'utf8' }).status === 0;
  it.skipIf(!shellcheck)('passes shellcheck (if installed)', () => {
    const result = spawnSync('shellcheck', [SCRIPT], { encoding: 'utf8' });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('shows the help', () => {
    const result = spawnSync('bash', [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    for (const flag of ['--mode', '--method', '--domain', '--email', '--dir', '--port', '--ref', '--version', '--build', '--no-build', '--image', '--with-python', '--yes', '--dry-run', '--update', '--uninstall', '--purge', '--source']) {
      expect(result.stdout).toContain(flag);
    }
  });

  const modes = ['serve', 'master', 'worker'] as const;
  const methods = ['docker', 'native'] as const;
  for (const runMode of modes) {
    for (const method of methods) {
      for (const domain of [undefined, 'flows.example.com']) {
        it(`${runMode} with ${method}${domain ? ' behind Caddy' : ''}`, () => {
          const dir = tempDir();
          const args = ['--mode', runMode, '--method', method, '--dir', dir];
          if (domain) args.push('--domain', domain, '--email', 'ops@example.com');
          const run = install(args);
          expect(run.status, run.output).toBe(0);
          expect(run.output).toContain('dry run finished');

          const port = runMode === 'master' ? 5679 : 5678;
          const envFile = join(dir, method === 'docker' ? '.env' : 'filuflow.env');
          expect(mode(envFile)).toBe(0o600);
          const env = parseEnv(envFile);

          // keys per mode
          expect(env.FILUFLOW_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
          if (runMode === 'master') {
            expect(env.FILUFLOW_API_KEY).toBeUndefined();
            expect(env.FILUFLOW_WEBHOOK_URL).toBeUndefined();
            expect(env.FILUFLOW_PUBLIC_URL).toEqual(domain ? `https://${domain}` : expect.stringMatching(new RegExp(`^http://.+:${port}$`)));
            expect(env.FILUFLOW_TRUST_PROXY).toBe(domain ? 'true' : 'false');
          } else {
            expect(env.FILUFLOW_API_KEY).toMatch(/^[0-9a-f]{64}$/);
            expect(env.FILUFLOW_API_KEY).not.toBe(env.FILUFLOW_ENCRYPTION_KEY);
            expect(env.FILUFLOW_WEBHOOK_URL).toEqual(domain ? `https://${domain}/` : expect.stringMatching(new RegExp(`^http://.+:${port}/$`)));
            expect(env.FILUFLOW_PUBLIC_URL).toBeUndefined();
            expect(env.FILUFLOW_TIMEZONE).toBeTruthy();
          }

          if (method === 'docker') {
            // default: the published image of the latest release, recorded in .env
            const compose = readFileSync(join(dir, 'docker-compose.yml'), 'utf8');
            expect(compose).not.toContain('build:');
            expect(compose).toContain('image: ${FILUFLOW_IMAGE:?');
            expect(env.FILUFLOW_IMAGE).toBe(`${RELEASE_IMAGE}:${LATEST}`);
            expect(run.output).not.toContain('git -C');
            expect(run.output).toContain('docker compose pull');
            expect(compose).toContain('env_file: .env');
            expect(compose).toContain('- ./data:/data');
            expect(compose).toContain('restart: unless-stopped');
            expect(compose).toContain(domain ? `- "127.0.0.1:${port}:${port}"` : `- "${port}:${port}"`);
            expect(compose).toContain(`"/app/bin/filuflow.js", "${runMode}"`);
            if (runMode === 'master') expect(compose).toContain('"--db", "/data/master.db"');
            expect(existsSync(join(dir, 'filuflow.service'))).toBe(false);
            expect(readFileSync(join(dir, '.install.conf'), 'utf8')).toContain(`MODE=${runMode}`);
          } else {
            const unit = readFileSync(join(dir, 'filuflow.service'), 'utf8');
            expect(mode(join(dir, 'filuflow.service'))).toBe(0o644);
            expect(unit).toContain('User=filuflow');
            expect(unit).toContain('EnvironmentFile=/etc/filuflow/filuflow.env');
            expect(unit).toMatch(new RegExp(`^ExecStart=\\S+node ${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/app/bin/filuflow\\.js ${runMode}$`, 'm'));
            for (const option of ['NoNewPrivileges=true', 'ProtectSystem=strict', 'ProtectHome=true', 'PrivateTmp=true', 'ReadWritePaths=/var/lib/filuflow', 'WorkingDirectory=/var/lib/filuflow', 'Restart=on-failure']) {
              expect(unit).toContain(option);
            }
            expect(env.FILUFLOW_HOST).toBe(domain ? '127.0.0.1' : '0.0.0.0');
            expect(env.FILUFLOW_PORT).toBe(String(port));
            if (runMode === 'master') expect(env.FILUFLOW_MASTER_DB).toBe('/var/lib/filuflow/master.db');
            else {
              expect(env.FILUFLOW_DIR).toBe('/var/lib/filuflow/workflows');
              expect(env.FILUFLOW_DB).toBe('/var/lib/filuflow/filuflow.db');
              expect(env.FILUFLOW_MANAGED_CREDENTIALS).toBe('/var/lib/filuflow/credentials.managed.json');
            }
            expect(existsSync(join(dir, 'docker-compose.yml'))).toBe(false);
            expect(readFileSync(join(dir, 'install.conf'), 'utf8')).toContain('METHOD=native');
            // native: the release tag, not main
            expect(run.output).toContain(`fetch --depth 1 origin v${LATEST}`);
            expect(env.FILUFLOW_IMAGE).toBeUndefined();
          }

          const caddyFile = join(dir, 'filuflow.caddy');
          if (domain) {
            const caddy = readFileSync(caddyFile, 'utf8');
            expect(caddy).toContain(`${domain} {`);
            expect(caddy).toContain('tls ops@example.com');
            expect(caddy).toContain(`reverse_proxy 127.0.0.1:${port}`);
          } else {
            expect(existsSync(caddyFile)).toBe(false);
          }

          // nothing installed or started, only shown
          expect(run.output).toContain('[dry-run]');
          expect(run.output).not.toMatch(/^\s+\+ /m);

          const secrets = [env.FILUFLOW_ENCRYPTION_KEY, ...(env.FILUFLOW_API_KEY ? [env.FILUFLOW_API_KEY] : [])];
          expectSecretsOnlyInEnv(dir, envFile, secrets, run.output);
          expect(run.output).toContain('Store the encryption key in a safe place');
        });
      }
    }
  }

  it('keeps secrets and own settings on a re-run and updates the address', () => {
    const dir = tempDir();
    expect(install(['--mode', 'worker', '--dir', dir]).status).toBe(0);
    const envFile = join(dir, '.env');
    const before = parseEnv(envFile);
    appendFileSync(envFile, 'FL_OWN=1\n');

    const again = install(['--dir', dir, '--domain', 'worker.example.com']);
    expect(again.status, again.output).toBe(0);
    expect(again.output).toContain('existing installation');
    expect(again.output).not.toContain('Generated secrets');
    const after = parseEnv(envFile);
    expect(after.FILUFLOW_API_KEY).toBe(before.FILUFLOW_API_KEY);
    expect(after.FILUFLOW_ENCRYPTION_KEY).toBe(before.FILUFLOW_ENCRYPTION_KEY);
    expect(after.FL_OWN).toBe('1');
    expect(after.FILUFLOW_WEBHOOK_URL).toBe('https://worker.example.com/');
    expect(mode(envFile)).toBe(0o600);
    expect(readFileSync(join(dir, 'docker-compose.yml'), 'utf8')).toContain('"127.0.0.1:5678:5678"');
    expect(readFileSync(join(dir, 'filuflow.caddy'), 'utf8')).toContain('worker.example.com {');
    expect(count(readFileSync(envFile, 'utf8'), 'FILUFLOW_WEBHOOK_URL=')).toBe(1);

    // --update without changes, then removing the domain again
    expect(install(['--update', '--dir', dir]).status).toBe(0);
    const removed = install(['--dir', dir, '--no-domain']);
    expect(removed.status, removed.output).toBe(0);
    expect(existsSync(join(dir, 'filuflow.caddy'))).toBe(false);
    expect(parseEnv(envFile).FILUFLOW_WEBHOOK_URL).toMatch(/^http:\/\/.+:5678\/$/);

    // mode and method cannot change on an existing installation
    expect(install(['--dir', dir, '--mode', 'master']).status).not.toBe(0);
    expect(install(['--dir', dir, '--method', 'native']).status).not.toBe(0);
  });

  it('takes given secrets and the first admin of the master', () => {
    const dir = tempDir();
    const run = install(['--mode', 'master', '--method', 'native', '--dir', dir, '--admin-email', 'ada@example.com'], {
      FILUFLOW_ENCRYPTION_KEY: 'given-encryption-key-123',
      FILUFLOW_ADMIN_PASSWORD: 'a-long-admin-password',
    });
    expect(run.status, run.output).toBe(0);
    const envFile = join(dir, 'filuflow.env');
    const env = parseEnv(envFile);
    expect(env.FILUFLOW_ENCRYPTION_KEY).toBe('given-encryption-key-123');
    expect(env.FILUFLOW_ADMIN_EMAIL).toBe('ada@example.com');
    expect(env.FILUFLOW_ADMIN_PASSWORD).toBe('a-long-admin-password');
    // given secrets are not printed
    expect(run.output).not.toContain('given-encryption-key-123');
    expect(run.output).not.toContain('a-long-admin-password');
    for (const file of filesIn(dir)) {
      if (file !== envFile) expect(readFileSync(file, 'utf8')).not.toContain('a-long-admin-password');
    }

    // generated admin password: in the env file and printed once
    const dir2 = tempDir();
    const run2 = install(['--mode', 'master', '--dir', dir2, '--admin-email', 'ada@example.com']);
    expect(run2.status, run2.output).toBe(0);
    const env2 = parseEnv(join(dir2, '.env'));
    expect(env2.FILUFLOW_ADMIN_PASSWORD).toMatch(/^[0-9a-f]{24}$/);
    expectSecretsOnlyInEnv(dir2, join(dir2, '.env'), [env2.FILUFLOW_ADMIN_PASSWORD, env2.FILUFLOW_ENCRYPTION_KEY], run2.output);
  });

  it('uses a prebuilt image and Python on request', () => {
    const dir = tempDir();
    const run = install(['--dir', dir, '--image', 'ghcr.io/mebytede/filuflow:main']);
    expect(run.status, run.output).toBe(0);
    const compose = readFileSync(join(dir, 'docker-compose.yml'), 'utf8');
    expect(compose).toContain('image: ${FILUFLOW_IMAGE:?');
    expect(parseEnv(join(dir, '.env')).FILUFLOW_IMAGE).toBe('ghcr.io/mebytede/filuflow:main');
    expect(compose).not.toContain('build:');
    expect(run.output).not.toContain('git -C');

    const dir2 = tempDir();
    expect(install(['--dir', dir2, '--with-python', '--ref', 'v1.2.3']).status).toBe(0);
    expect(readFileSync(join(dir2, 'docker-compose.yml'), 'utf8')).toContain('WITH_PYTHON: "true"');
    expect(readFileSync(join(dir2, '.install.conf'), 'utf8')).toContain('REF=v1.2.3');
  });

  it('copies a local checkout with --source', () => {
    const dir = tempDir();
    const run = install(['--dir', dir, '--source', resolve(import.meta.dirname, '..')]);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('Copying the local checkout');
    expect(run.output).not.toContain('git -C');
    expect(install(['--dir', tempDir(), '--source', tmpdir()]).status).not.toBe(0);
  });

  it('rejects invalid input', () => {
    const cases: string[][] = [
      ['--mode', 'cluster'],
      ['--method', 'podman'],
      ['--port', '70000'],
      ['--port', 'abc'],
      ['--domain', 'not a domain'],
      ['--domain', 'localhost'],
      ['--domain', 'flows.example.com', '--port', '443'],
      ['--email', 'nope'],
      ['--api-key', 'short'],
      ['--encryption-key', 'short'],
      ['--admin-email', 'ada@example.com'],
      ['--mode', 'master', '--admin-email', 'ada@example.com', '--admin-password', 'short'],
      ['--method', 'native', '--image', 'filuflow:x'],
      ['--ref', 'main;rm -rf /'],
      ['--version', 'main'],
      ['--version', '1.2'],
      ['--version', 'v1.2.3;rm -rf /'],
      ['--version', '1.2.3', '--ref', 'main'],
      ['--image', 'filuflow:x', '--version', '1.2.3'],
      ['--image', 'filuflow:x', '--build'],
      ['--source', '/tmp', '--version', '1.2.3'],
      ['--ref', 'main', '--no-build'],
      ['--method', 'native', '--no-build'],
      ['--purge'],
      ['--unknown-flag'],
    ];
    for (const args of cases) {
      const dir = tempDir();
      const run = install(['--dir', dir, ...args]);
      expect(run.status, args.join(' ')).not.toBe(0);
      expect(run.stderr).toContain('Error:');
      expect(existsSync(dir), args.join(' ')).toBe(false);
    }
    expect(install(['--dir', 'relative/path']).status).not.toBe(0);
  });

  it('uninstalls and keeps data unless --purge is given', () => {
    const dir = tempDir();
    expect(install(['--uninstall', '--dir', dir]).stderr).toContain('no installation found');
    expect(install(['--update', '--dir', dir]).stderr).toContain('no installation found');

    expect(install(['--method', 'native', '--dir', dir, '--domain', 'flows.example.com']).status).toBe(0);
    const keep = install(['--uninstall', '--dir', dir]);
    expect(keep.status, keep.output).toBe(0);
    expect(keep.output).toContain('systemctl disable --now filuflow');
    expect(keep.output).toContain('data and settings are kept');
    expect(keep.output).not.toMatch(/rm -rf/);

    const purge = install(['--uninstall', '--purge', '--dir', dir]);
    expect(purge.status, purge.output).toBe(0);
    expect(purge.output).toContain('rm -rf');
    expect(purge.output).toContain('/var/lib/filuflow');
    expect(purge.output).toContain('userdel filuflow');

    const docker = tempDir();
    expect(install(['--dir', docker]).status).toBe(0);
    expect(install(['--uninstall', '--dir', docker]).output).toContain('docker compose down --remove-orphans');
    expect(install(['--uninstall', '--purge', '--dir', docker]).output).toContain('--rmi local');
    // dry run: the generated files are still there
    expect(existsSync(join(docker, '.env'))).toBe(true);
  });

  describe('versions', () => {
    const conf = (dir: string) => parseEnv(join(dir, '.install.conf'));
    const compose = (dir: string) => readFileSync(join(dir, 'docker-compose.yml'), 'utf8');
    const envOf = (dir: string) => parseEnv(join(dir, '.env'));

    it('pulls the image of the latest release by default', () => {
      const dir = tempDir();
      const run = install(['--dir', dir]);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain(`version: ${LATEST} (image ${RELEASE_IMAGE}:${LATEST})`);
      expect(run.output).toContain(`Version:        ${LATEST}`);
      expect(run.output).toContain('add --version X.Y.Z to pin');
      expect(envOf(dir).FILUFLOW_IMAGE).toBe(`${RELEASE_IMAGE}:${LATEST}`);
      expect(conf(dir)).toMatchObject({ KIND: 'release', VERSION: LATEST, BUILD: 'false', REF: '', IMAGE: '' });
      expect(run.output).not.toContain('docker compose build');
    });

    it('pins a version given with or without "v", including pre-releases', () => {
      for (const [given, tag] of [['1.2.3', '1.2.3'], ['v1.2.3', '1.2.3'], ['1.3.0-rc.1', '1.3.0-rc.1']]) {
        const dir = tempDir();
        const run = install(['--dir', dir, '--version', given]);
        expect(run.status, run.output).toBe(0);
        expect(run.output).not.toContain('Looking up the latest release');
        expect(envOf(dir).FILUFLOW_IMAGE).toBe(`${RELEASE_IMAGE}:${tag}`);
        expect(conf(dir).VERSION).toBe(tag);
      }
      // "latest" resolves
      const dir = tempDir();
      expect(install(['--dir', dir, '--version', 'latest']).status).toBe(0);
      expect(conf(dir).VERSION).toBe(LATEST);
    });

    it('builds the release from source with --build, a git ref with --ref and a local checkout with --source', () => {
      const build = tempDir();
      const run = install(['--dir', build, '--build', '--version', '1.2.3']);
      expect(run.status, run.output).toBe(0);
      expect(compose(build)).toContain('context: ./app');
      expect(compose(build)).toContain('image: filuflow:local');
      expect(envOf(build).FILUFLOW_IMAGE).toBeUndefined();
      expect(run.output).toContain('fetch --depth 1 origin v1.2.3');
      expect(run.output).toContain('docker compose build --pull');
      expect(run.output).toContain('1.2.3 (built from git tag v1.2.3)');
      expect(conf(build)).toMatchObject({ KIND: 'release', VERSION: '1.2.3', BUILD: 'true' });

      const ref = tempDir();
      const refRun = install(['--dir', ref, '--ref', 'main']);
      expect(refRun.status, refRun.output).toBe(0);
      expect(compose(ref)).toContain('context: ./app');
      expect(refRun.output).toContain('fetch --depth 1 origin main');
      expect(refRun.output).not.toContain('Looking up the latest release');
      expect(conf(ref)).toMatchObject({ KIND: 'ref', REF: 'main', VERSION: '' });

      const source = tempDir();
      const sourceRun = install(['--dir', source, '--source', resolve(import.meta.dirname, '..')]);
      expect(sourceRun.status, sourceRun.output).toBe(0);
      expect(compose(source)).toContain('context: ./app');
      expect(conf(source)).toMatchObject({ KIND: 'source', VERSION: '' });
    });

    it('uses an own image with --image', () => {
      const dir = tempDir();
      const run = install(['--dir', dir, '--image', 'registry.example.com/filuflow:custom']);
      expect(run.status, run.output).toBe(0);
      expect(envOf(dir).FILUFLOW_IMAGE).toBe('registry.example.com/filuflow:custom');
      expect(conf(dir)).toMatchObject({ KIND: 'image', IMAGE: 'registry.example.com/filuflow:custom', VERSION: '' });
      expect(run.output).not.toContain('Looking up the latest release');
    });

    it('installs the release tag natively, or a given ref', () => {
      const dir = tempDir();
      const run = install(['--dir', dir, '--method', 'native', '--version', 'v2.0.1']);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain('fetch --depth 1 origin v2.0.1');
      expect(parseEnv(join(dir, 'install.conf'))).toMatchObject({ KIND: 'release', VERSION: '2.0.1' });
      const ref = tempDir();
      const refRun = install(['--dir', ref, '--method', 'native', '--ref', 'main']);
      expect(refRun.output).toContain('fetch --depth 1 origin main');
    });

    it('moves to the latest release on --update, keeps the version on a plain re-run, pins with --version', () => {
      const dir = tempDir();
      expect(install(['--dir', dir], { FILUFLOW_INSTALL_LATEST_VERSION: '1.0.0' }).status).toBe(0);
      const update = install(['--update', '--dir', dir], { FILUFLOW_INSTALL_LATEST_VERSION: 'v1.1.0' });
      expect(update.status, update.output).toBe(0);
      expect(update.output).toContain(`version: 1.0.0 (image ${RELEASE_IMAGE}:1.0.0) -> 1.1.0 (image ${RELEASE_IMAGE}:1.1.0)`);
      expect(update.output).toContain('Version:        1.0.0');
      expect(update.output).toContain('docker compose pull');
      expect(envOf(dir).FILUFLOW_IMAGE).toBe(`${RELEASE_IMAGE}:1.1.0`);
      expect(count(readFileSync(join(dir, '.env'), 'utf8'), 'FILUFLOW_IMAGE=')).toBe(1);

      const rerun = install(['--dir', dir, '--port', '5680'], { FILUFLOW_INSTALL_LATEST_VERSION: '1.2.0' });
      expect(rerun.status, rerun.output).toBe(0);
      expect(rerun.output).toContain('(unchanged)');
      expect(conf(dir).VERSION).toBe('1.1.0');

      const pin = install(['--update', '--dir', dir, '--version', '1.0.5'], { FILUFLOW_INSTALL_LATEST_VERSION: '1.2.0' });
      expect(pin.status, pin.output).toBe(0);
      expect(envOf(dir).FILUFLOW_IMAGE).toBe(`${RELEASE_IMAGE}:1.0.5`);
      expect(conf(dir)).toMatchObject({ VERSION: '1.0.5', PORT: '5680' });
    });

    it('keeps building from source on --update when installed with --build, --ref or --source', () => {
      const build = tempDir();
      expect(install(['--dir', build, '--build'], { FILUFLOW_INSTALL_LATEST_VERSION: '1.0.0' }).status).toBe(0);
      const update = install(['--update', '--dir', build], { FILUFLOW_INSTALL_LATEST_VERSION: '1.1.0' });
      expect(update.status, update.output).toBe(0);
      expect(update.output).toContain('fetch --depth 1 origin v1.1.0');
      expect(compose(build)).toContain('context: ./app');
      expect(conf(build)).toMatchObject({ KIND: 'release', VERSION: '1.1.0', BUILD: 'true' });
      // back to the published image
      expect(install(['--update', '--dir', build, '--no-build']).status).toBe(0);
      expect(envOf(build).FILUFLOW_IMAGE).toBe(`${RELEASE_IMAGE}:${LATEST}`);
      expect(conf(build).BUILD).toBe('false');

      const ref = tempDir();
      expect(install(['--dir', ref, '--ref', 'main']).status).toBe(0);
      const refUpdate = install(['--update', '--dir', ref]);
      expect(refUpdate.status, refUpdate.output).toBe(0);
      expect(refUpdate.output).toContain('fetch --depth 1 origin main');
      expect(refUpdate.output).toContain('version: git ref main (built from source) (unchanged)');
      expect(conf(ref).KIND).toBe('ref');
      // --version switches a ref installation to releases and keeps building
      expect(install(['--update', '--dir', ref, '--version', 'latest']).status).toBe(0);
      expect(conf(ref)).toMatchObject({ KIND: 'release', VERSION: LATEST, BUILD: 'true', REF: '' });

      const source = tempDir();
      expect(install(['--dir', source, '--source', resolve(import.meta.dirname, '..')]).status).toBe(0);
      const sourceUpdate = install(['--update', '--dir', source]);
      expect(sourceUpdate.status, sourceUpdate.output).toBe(0);
      expect(sourceUpdate.output).toContain('Copying the local checkout');
      expect(conf(source).KIND).toBe('source');
    });

    it('keeps an own image on --update and switches to releases with --version', () => {
      const dir = tempDir();
      expect(install(['--dir', dir, '--image', 'registry.example.com/filuflow:custom']).status).toBe(0);
      expect(install(['--update', '--dir', dir]).status).toBe(0);
      expect(envOf(dir).FILUFLOW_IMAGE).toBe('registry.example.com/filuflow:custom');
      expect(install(['--update', '--dir', dir, '--version', '2.0.0']).status).toBe(0);
      expect(envOf(dir).FILUFLOW_IMAGE).toBe(`${RELEASE_IMAGE}:2.0.0`);
      expect(conf(dir)).toMatchObject({ KIND: 'release', IMAGE: '', BUILD: 'false' });
    });

    it('falls back to the latest image tag when the release cannot be determined', () => {
      const dir = tempDir();
      const run = install(['--dir', dir], { FILUFLOW_INSTALL_LATEST_VERSION: '' });
      expect(run.status, run.output).toBe(0);
      expect(run.stderr).toContain('could not determine the latest release');
      expect(envOf(dir).FILUFLOW_IMAGE).toBe(`${RELEASE_IMAGE}:latest`);
      expect(conf(dir).VERSION).toBe('');
      // building needs a tag: the dry run shows main
      const native = tempDir();
      const nativeRun = install(['--dir', native, '--method', 'native'], { FILUFLOW_INSTALL_LATEST_VERSION: '' });
      expect(nativeRun.status, nativeRun.output).toBe(0);
      expect(nativeRun.output).toContain('fetch --depth 1 origin main');
    });

    it('treats an installation from before versions as a git ref installation', () => {
      const dir = tempDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.install.conf'), 'MODE=serve\nMETHOD=docker\nPORT=5678\nREF=main\nIMAGE=\nSOURCE=\n');
      const run = install(['--update', '--dir', dir]);
      expect(run.status, run.output).toBe(0);
      expect(run.output).toContain('fetch --depth 1 origin main');
      expect(conf(dir)).toMatchObject({ KIND: 'ref', REF: 'main' });
    });
  });
});
