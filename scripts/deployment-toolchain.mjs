import { createHash } from 'node:crypto';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

// Linux x64 is the supported disposable deployment-test executor. Tool identity
// is independent of the workstation's PATH and downloaded bytes are checked.
export const deploymentTools = Object.freeze({
  helm: {
    version: '4.2.4',
    url: 'https://get.helm.sh/helm-v4.2.4-linux-amd64.tar.gz',
    sha256: 'c306b46f719b0a4da32d0f78ee21bf90ce8d602f15b22ab753f0674d1670a7f3',
  },
  kind: {
    version: '0.33.0',
    url: 'https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64',
    sha256: 'aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d',
  },
  kubectl: {
    version: '1.37.0',
    url: 'https://dl.k8s.io/release/v1.37.0/bin/linux/amd64/kubectl',
    sha256: '6129359f4e1f3848a5572ccb0b26cf28b8ca08cef38c95a765b2f64a2c961a2f',
  },
});

export async function installDeploymentTool(name, directory) {
  const tool = deploymentTools[name];
  if (!tool || process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('Deployment test tools support Linux x64 and helm/kind/kubectl only');
  }
  const response = await fetch(tool.url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Cannot download ${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== tool.sha256) {
    throw new Error(`Downloaded ${name} checksum mismatch`);
  }
  await mkdir(directory, { recursive: true });
  const destination = resolve(directory, name);
  if (name !== 'helm') {
    await writeFile(destination, bytes, { mode: 0o755 });
  } else {
    const scratch = await mkdtemp(join(tmpdir(), 'smrt-helm-'));
    try {
      const archive = join(scratch, 'helm.tar.gz');
      await writeFile(archive, bytes);
      execFileSync('tar', ['-xzf', archive, '-C', scratch, 'linux-amd64/helm']);
      const { readFile } = await import('node:fs/promises');
      await writeFile(destination, await readFile(join(scratch, 'linux-amd64/helm')), { mode: 0o755 });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return destination;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [name, directory] = process.argv.slice(2);
  if (!directory) throw new Error('Usage: node scripts/deployment-toolchain.mjs helm|kind|kubectl DIRECTORY');
  console.log(await installDeploymentTool(name, directory));
}
