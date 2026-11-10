import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const TOKEN_FILE = join(homedir(), '.fixture-app', 'token.json');

export async function saveDeviceToken(token: string) {
  await mkdir(join(homedir(), '.fixture-app'), { recursive: true });
  const record = { token, expiresIn: '7d', createdAt: Date.now() };
  await writeFile(TOKEN_FILE, JSON.stringify(record));
}
