/**
 * Git Loader — download, redirect, extraction, and config-validation tests.
 *
 * Complements git-loader.spec.ts (which only drives the network-error path) by
 * exercising the success path, HTTP redirect handling (including SSRF redirect
 * rejection), HTTP error statuses, oversized-tarball rejection, and template
 * config loading/validation. We mock node:https and tar at the boundary, and
 * let the real filesystem hold the extracted template.config.js.
 */

import { EventEmitter, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockHttpsGet, mockExtract, extractState } = vi.hoisted(() => {
  const state: { cwd?: string; onFinish?: () => void } = {};
  return {
    mockHttpsGet: vi.fn(),
    mockExtract: vi.fn(),
    extractState: state,
  };
});

vi.mock('node:https', () => ({
  default: { get: mockHttpsGet },
}));

vi.mock('tar', () => ({
  extract: mockExtract,
}));

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanupGitTemplate,
  getGitTemplateDir,
  loadGitTemplate,
} from './git-loader.js';

/**
 * Build a fake https.get that immediately returns a successful (200) response
 * with no body bytes; extraction completion is driven by the tar mock.
 */
function fakeSuccessfulGet() {
  return (_url: string, callback: any) => {
    const req = new EventEmitter() as any;
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();

    const response = new Readable({ read() {} }) as any;
    response.statusCode = 200;
    response.headers = {};
    setImmediate(() => {
      callback(response);
      // No data emitted; just end so the pipe completes.
      response.push(null);
    });
    return req;
  };
}

/**
 * Build a fake https.get that issues a redirect to the provided location.
 */
function fakeRedirectGet(location: string | undefined, status = 302) {
  return (_url: string, callback: any) => {
    const req = new EventEmitter() as any;
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();
    const response = new Readable({ read() {} }) as any;
    response.statusCode = status;
    response.headers = location ? { location } : {};
    setImmediate(() => callback(response));
    return req;
  };
}

/**
 * Build a fake https.get that returns an error status.
 */
function fakeErrorStatusGet(status: number) {
  return (_url: string, callback: any) => {
    const req = new EventEmitter() as any;
    req.setTimeout = vi.fn();
    req.destroy = vi.fn();
    const response = new Readable({ read() {} }) as any;
    response.statusCode = status;
    response.headers = {};
    setImmediate(() => callback(response));
    return req;
  };
}

let tempRoot: string;

describe('git-loader (download + extraction)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    extractState.cwd = undefined;
    extractState.onFinish = undefined;
    tempRoot = mkdtempSync(join(tmpdir(), 'smrt-git-loader-'));

    // The tar mock records the cwd it was asked to extract into and returns a
    // writable-ish stream we can drive to completion.
    mockExtract.mockImplementation((opts: any) => {
      extractState.cwd = opts.cwd;
      const stream = new EventEmitter() as any;
      stream.write = vi.fn();
      stream.end = vi.fn();
      stream.on = stream.on.bind(stream);
      // Emit finish on next tick after the response pipes into it.
      setImmediate(() => stream.emit('finish'));
      return stream;
    });
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it('throws when no template.config file exists after extraction', async () => {
    mockHttpsGet.mockImplementation(fakeSuccessfulGet());

    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /No template\.config\.js or template\.config\.ts found/,
    );
  });

  it('loads a template.config.js produced by extraction', async () => {
    // When tar.extract runs, drop a valid config into the extraction cwd so the
    // subsequent dynamic import succeeds.
    mockExtract.mockImplementation((opts: any) => {
      extractState.cwd = opts.cwd;
      const stream = new EventEmitter() as any;
      stream.write = vi.fn();
      stream.end = vi.fn();
      setImmediate(() => {
        mkdirSync(opts.cwd, { recursive: true });
        writeFileSync(
          join(opts.cwd, 'template.config.js'),
          `export default ${JSON.stringify({
            name: 'Git Template',
            description: 'From git',
            dependencies: { dep: '1.0.0' },
          })};`,
          'utf-8',
        );
        stream.emit('finish');
      });
      return stream;
    });
    mockHttpsGet.mockImplementation(fakeSuccessfulGet());

    const config = await loadGitTemplate('github:user/repo');
    expect(config.name).toBe('Git Template');
    // getGitTemplateDir returns the temp dir stamped on the config.
    expect(getGitTemplateDir(config)).toContain('smrt-template-user-repo');

    // cleanup removes the temp dir without throwing.
    await expect(cleanupGitTemplate(config)).resolves.toBeUndefined();
  });

  // When the extracted .js config loads but fails validation, loadGitTemplate's
  // outer try/catch swallows the validation error and falls through to the .ts
  // attempt, which then fails to import — surfacing as a "no config" error.
  it('surfaces an error when an extracted config fails validation', async () => {
    mockExtract.mockImplementation((opts: any) => {
      extractState.cwd = opts.cwd;
      const stream = new EventEmitter() as any;
      stream.write = vi.fn();
      stream.end = vi.fn();
      setImmediate(() => {
        mkdirSync(opts.cwd, { recursive: true });
        writeFileSync(
          join(opts.cwd, 'template.config.js'),
          `export default ${JSON.stringify({
            name: 'Incomplete',
            description: 'no deps',
          })};`,
          'utf-8',
        );
        stream.emit('finish');
      });
      return stream;
    });
    mockHttpsGet.mockImplementation(fakeSuccessfulGet());

    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /No template\.config/,
    );
  });

  it('follows a redirect to a trusted host', async () => {
    let call = 0;
    mockHttpsGet.mockImplementation((url: string, callback: any) => {
      call += 1;
      if (call === 1) {
        return fakeRedirectGet('https://codeload.github.com/user/repo/tar.gz')(
          url,
          callback,
        );
      }
      return fakeSuccessfulGet()(url, callback);
    });

    // First (redirect) then success but no config -> ends at config-missing,
    // proving the redirect was followed to a second request.
    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /No template\.config/,
    );
    expect(mockHttpsGet).toHaveBeenCalledTimes(2);
  });

  it('rejects a redirect to an untrusted host (SSRF guard)', async () => {
    mockHttpsGet.mockImplementation(
      fakeRedirectGet('https://evil.example.com/payload.tar.gz'),
    );

    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /untrusted host/,
    );
  });

  it('rejects a redirect to an internal address (SSRF guard)', async () => {
    mockHttpsGet.mockImplementation(
      // 127.0.0.1 is not in the trusted-host allowlist, so it is rejected as an
      // untrusted host before the internal-address check.
      fakeRedirectGet('https://127.0.0.1/payload.tar.gz'),
    );

    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /untrusted host|internal/,
    );
  });

  it('rejects a non-https redirect protocol', async () => {
    mockHttpsGet.mockImplementation(
      fakeRedirectGet('http://github.com/user/repo.tar.gz'),
    );

    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /Invalid redirect protocol/,
    );
  });

  it('rejects a malformed redirect URL', async () => {
    mockHttpsGet.mockImplementation(fakeRedirectGet('::::not a url::::'));

    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /Invalid redirect URL format|Invalid redirect protocol/,
    );
  });

  it('rejects a redirect without a location header', async () => {
    mockHttpsGet.mockImplementation(fakeRedirectGet(undefined));

    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /Redirect without location header/,
    );
  });

  it('rejects a non-200/redirect HTTP status', async () => {
    mockHttpsGet.mockImplementation(fakeErrorStatusGet(404));

    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /Failed to download tarball: HTTP 404/,
    );
  });

  it('constructs gitlab and bitbucket tarball URLs without parse errors', async () => {
    mockHttpsGet.mockImplementation(fakeSuccessfulGet());

    await expect(loadGitTemplate('gitlab:user/repo#main')).rejects.toThrow(
      /No template\.config/,
    );
    await expect(loadGitTemplate('bitbucket:user/repo#main')).rejects.toThrow(
      /No template\.config/,
    );
  });

  it('parses gitlab and bitbucket shorthand with subdirectories', async () => {
    mockHttpsGet.mockImplementation(fakeSuccessfulGet());

    await expect(
      loadGitTemplate('gitlab:user/repo/templates/sub#main'),
    ).rejects.toThrow(/No template\.config/);
    await expect(
      loadGitTemplate('bitbucket:user/repo/templates/sub#main'),
    ).rejects.toThrow(/No template\.config/);
  });

  it('parses gitlab and bitbucket HTTPS URLs with ref:subdir', async () => {
    mockHttpsGet.mockImplementation(fakeSuccessfulGet());

    await expect(
      loadGitTemplate('https://gitlab.com/user/repo.git#main:templates'),
    ).rejects.toThrow(/No template\.config/);
    await expect(
      loadGitTemplate('https://bitbucket.org/user/repo.git#main:templates'),
    ).rejects.toThrow(/No template\.config/);
  });

  it('rejects invalid GitLab and Bitbucket HTTPS URLs', async () => {
    await expect(loadGitTemplate('https://gitlab.com/')).rejects.toThrow(
      /Invalid GitLab URL/,
    );
    await expect(loadGitTemplate('https://bitbucket.org/')).rejects.toThrow(
      /Invalid Bitbucket URL/,
    );
  });

  it('rejects a tarball that exceeds the size limit', async () => {
    // The size monitor calls response.destroy(err); we mirror real stream
    // behavior by forwarding that error to the (mocked) extract stream, which
    // the loader listens to for rejection.
    let extractStream: any;
    mockExtract.mockImplementation(() => {
      extractStream = new EventEmitter() as any;
      extractStream.write = vi.fn();
      extractStream.end = vi.fn();
      return extractStream;
    });
    mockHttpsGet.mockImplementation((_url: string, callback: any) => {
      const req = new EventEmitter() as any;
      req.setTimeout = vi.fn();
      req.destroy = vi.fn();
      const response = new EventEmitter() as any;
      response.statusCode = 200;
      response.headers = {};
      response.pipe = vi.fn();
      response.destroy = vi.fn((err?: Error) => {
        // Real readable.destroy(err) surfaces via the piped extract stream.
        if (err && extractStream) extractStream.emit('error', err);
      });
      setImmediate(() => {
        callback(response);
        // Emit a chunk larger than the 100 MB limit to trip the monitor.
        response.emit('data', Buffer.alloc(101 * 1024 * 1024));
      });
      return req;
    });

    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /size exceeds limit/,
    );
  });

  it('rejects when tar extraction emits an error', async () => {
    mockExtract.mockImplementation(() => {
      const stream = new EventEmitter() as any;
      stream.write = vi.fn();
      stream.end = vi.fn();
      setImmediate(() => stream.emit('error', new Error('corrupt tarball')));
      return stream;
    });
    mockHttpsGet.mockImplementation(fakeSuccessfulGet());

    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /corrupt tarball/,
    );
  });

  it('rejects a request timeout', async () => {
    mockHttpsGet.mockImplementation((_url: string, _callback: any) => {
      const req = new EventEmitter() as any;
      req.destroy = vi.fn((err?: Error) => {
        if (err) req.emit('error', err);
      });
      // Invoke the timeout handler synchronously to simulate a stalled request.
      req.setTimeout = vi.fn((_ms: number, handler: () => void) => {
        setImmediate(handler);
      });
      return req;
    });

    await expect(loadGitTemplate('github:user/repo')).rejects.toThrow(
      /timed out/,
    );
  });

  it('falls back to template.config.ts when only a .ts config is extracted', async () => {
    // The .js import fails (file absent), then the .ts import succeeds because
    // we write a .js-syntax module under the .ts name and the loader imports it.
    mockExtract.mockImplementation((opts: any) => {
      const stream = new EventEmitter() as any;
      stream.write = vi.fn();
      stream.end = vi.fn();
      setImmediate(() => {
        mkdirSync(opts.cwd, { recursive: true });
        writeFileSync(
          join(opts.cwd, 'template.config.ts'),
          `export default ${JSON.stringify({
            name: 'TS Template',
            description: 'from ts',
            dependencies: { dep: '1.0.0' },
            devDependencies: { devdep: '1.0.0' },
          })};`,
          'utf-8',
        );
        stream.emit('finish');
      });
      return stream;
    });
    mockHttpsGet.mockImplementation(fakeSuccessfulGet());

    const config = await loadGitTemplate('github:user/repo');
    expect(config.name).toBe('TS Template');
    await cleanupGitTemplate(config);
  });
});
