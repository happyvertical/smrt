import { pathToFileURL } from 'node:url';

const repository = 'happyvertical/charts/smrt-app';

/** Read the same registry as Helm, using the publication job's own identity. */
export async function assertChartVersionAbsent(version, {
  actor = process.env.GITHUB_ACTOR,
  token = process.env.GHCR_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?(?:\+[\da-zA-Z.-]+)?$/.test(version)) {
    throw new Error('A valid chart version is required.');
  }
  if (!actor || !token) throw new Error('Chart registry credentials are required.');
  async function request(url, headers) {
    try {
      return await fetchImpl(url, {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('Chart registry request failed; publication blocked.');
    }
  }
  async function json(response) {
    try {
      return await response.json();
    } catch {
      throw new Error('Chart registry response is invalid; publication blocked.');
    }
  }
  const authentication = new URL('https://ghcr.io/token');
  authentication.searchParams.set('service', 'ghcr.io');
  authentication.searchParams.set('scope', `repository:${repository}:pull,push`);
  const authorized = await request(authentication, {
    Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}`,
  });
  if (authorized.status !== 200) throw new Error('Chart registry authentication failed; publication blocked.');
  const credentials = await json(authorized);
  if (typeof credentials?.token !== 'string' || !credentials.token.trim()) {
    throw new Error('Chart registry authentication response is invalid; publication blocked.');
  }
  // Helm maps SemVer build metadata '+' to '_' in OCI tags.
  const tag = version.replace('+', '_');
  const manifest = await request(`https://ghcr.io/v2/${repository}/manifests/${tag}`, {
    Authorization: `Bearer ${credentials.token}`,
    Accept: 'application/vnd.oci.image.manifest.v1+json',
  });
  if (manifest.status === 200) throw new Error('Chart version already exists; bump Chart.yaml before publication.');
  if (manifest.status !== 404) throw new Error('Chart registry lookup failed; publication blocked.');
  const body = await json(manifest);
  if (!Array.isArray(body?.errors) || body.errors.length === 0 ||
    !body.errors.every(error => ['MANIFEST_UNKNOWN', 'NAME_UNKNOWN'].includes(error?.code))) {
    throw new Error('Chart version absence is unconfirmed; publication blocked.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await assertChartVersionAbsent(process.argv[2]);
    console.log('Chart version is absent in the authenticated registry.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
