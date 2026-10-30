import { X509Certificate, createPrivateKey, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { promisify } from 'node:util';
import { demand } from './release.mjs';
const execute = promisify(execFile);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function pemCertificates(pem) {
  const certificates =
    pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    ) ?? [];
  demand(
    certificates.length > 0 &&
      certificates.length <= 8 &&
      pem
        .replace(
          /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
          '',
        )
        .trim() === '',
    'Invalid TLS certificate chain',
    'TLS_BINDING',
  );
  return certificates;
}
export async function inspectTlsSecret(
  secret,
  hosts,
  { trustedCa, minimumValiditySeconds = 0, now = Date.now() } = {},
) {
  let directory;
  try {
    demand(
      Number.isInteger(minimumValiditySeconds) &&
        minimumValiditySeconds >= 0 &&
        minimumValiditySeconds <= 604800,
      'Invalid TLS validity margin',
      'TLS_BINDING',
    );
    demand(
      secret?.immutable === true &&
        secret.type === 'kubernetes.io/tls' &&
        secret.metadata?.uid &&
        secret.metadata?.resourceVersion,
      'Missing immutable native TLS Secret identity',
      'TLS_BINDING',
    );
    const crt = secret.data?.['tls.crt'],
      key = secret.data?.['tls.key'];
    demand(
      typeof crt === 'string' &&
        typeof key === 'string' &&
        crt.length <= 131072 &&
        key.length <= 65536,
      'Missing bounded TLS certificate/key',
      'TLS_BINDING',
    );
    const pem = Buffer.from(crt, 'base64').toString();
    const certificates = pemCertificates(pem);
    const leaf = new X509Certificate(certificates[0]);
    demand(
      leaf.checkPrivateKey(createPrivateKey(Buffer.from(key, 'base64'))),
      'TLS key does not match certificate',
      'TLS_BINDING',
    );
    demand(
      Date.parse(leaf.validFrom) <= now &&
        Date.parse(leaf.validTo) > now + minimumValiditySeconds * 1000,
      'TLS certificate is not currently valid with required margin',
      'TLS_BINDING',
    );
    demand(
      Array.isArray(hosts) &&
        hosts.length > 0 &&
        hosts.every(
          (host) =>
            typeof host === 'string' &&
            leaf.checkHost(host, { subject: 'never' }),
        ),
      'TLS certificate SAN does not match declared host',
      'TLS_BINDING',
    );
    directory = await mkdtemp(join(tmpdir(), 'smrt-tls-public-'));
    const leafPath = join(directory, 'leaf.pem');
    await writeFile(leafPath, certificates[0], { mode: 0o600 });
    const args = [
      'verify',
      '-purpose',
      'sslserver',
      '-attime',
      String(Math.floor(now / 1000)),
    ];
    if (trustedCa) {
      demand(
        Array.isArray(trustedCa) && trustedCa.length > 0,
        'Missing explicit trusted TLS CA',
        'TLS_BINDING',
      );
      const roots = join(directory, 'roots.pem');
      demand(
        trustedCa.every(
          (ca) => typeof ca === 'string' && pemCertificates(ca).length > 0,
        ),
        'Trusted CA must contain public certificates only',
        'TLS_BINDING',
      );
      await writeFile(roots, trustedCa.join('\n'), { mode: 0o600 });
      args.push('-CAfile', roots, '-no-CApath', '-no-CAstore');
    }
    if (certificates.length > 1) {
      const intermediates = join(directory, 'chain.pem');
      await writeFile(intermediates, certificates.slice(1).join('\n'), {
        mode: 0o600,
      });
      args.push('-untrusted', intermediates);
    }
    for (const host of hosts)
      await execute('openssl', [...args, '-verify_hostname', host, leafPath], {
        timeout: 10000,
        maxBuffer: 65536,
      });
    return {
      name: secret.metadata.name,
      uid: secret.metadata.uid,
      resourceVersion: secret.metadata.resourceVersion,
      leafSha256: sha(leaf.raw),
    };
  } catch (error) {
    demand(
      false,
      error?.code === 'TLS_BINDING'
        ? error.message
        : 'Native TLS certificate/key/chain validation failed',
      'TLS_BINDING',
    );
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
export async function servedTlsIdentity(
  host,
  port,
  expected,
  { trustedCa, endpoint } = {},
) {
  const address = endpoint ? await endpoint(host, port) : { host, port };
  demand(
    address &&
      typeof address.host === 'string' &&
      Number.isInteger(address.port) &&
      address.port > 0 &&
      address.port <= 65535,
    'Invalid trusted TLS endpoint mapping',
    'TLS_TRANSPORT',
  );
  return new Promise((resolve, reject) => {
    const socket = connect({
      host: address.host,
      port: address.port,
      servername: host,
      ca: trustedCa,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('TLS transport timeout'));
    }, 10000);
    socket.once('error', () => {
      clearTimeout(timer);
      reject(new Error('TLS transport failed'));
    });
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      const peer = socket.getPeerCertificate();
      socket.end();
      if (!peer?.raw) {
        reject(new Error('TLS peer certificate unavailable'));
        return;
      }
      const actual = sha(peer.raw);
      const code = !socket.authorized
        ? socket.authorizationError === 'ERR_TLS_CERT_ALTNAME_INVALID'
          ? 'TLS_HOSTNAME'
          : 'TLS_TRUST'
        : actual !== expected
          ? 'TLS_CERTIFICATE'
          : null;
      resolve({
        host,
        expectedLeafSha256: expected,
        servedLeafSha256: actual,
        code,
        observedAt: Date.now(),
      });
    });
  });
}
export function retainedTlsIdentity(secret) {
  try {
    demand(
      secret?.immutable === true &&
        secret.type === 'kubernetes.io/tls' &&
        secret.metadata?.uid &&
        secret.metadata?.resourceVersion,
      'Missing retained immutable TLS identity',
      'TLS_BINDING',
    );
    const leaf = new X509Certificate(
      pemCertificates(
        Buffer.from(secret.data?.['tls.crt'] ?? '', 'base64').toString(),
      )[0],
    );
    return {
      name: secret.metadata.name,
      uid: secret.metadata.uid,
      resourceVersion: secret.metadata.resourceVersion,
      leafSha256: sha(leaf.raw),
    };
  } catch {
    demand(false, 'Retained TLS identity changed', 'TLS_BINDING');
  }
}
