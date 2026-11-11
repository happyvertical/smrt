import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BACKUP_SUFFIX = '.ci-original';

export function rewriteUbuntuMirrorList(text, security = false) {
  return text.replace(/^([ \t]*)(https?:\/\/[^\s]+)([^\r\n]*)/gim, (line, prefix, token, suffix) => {
    const raw = token.match(/^https?:\/\/([^/?#]+)(\/[^?#]*)$/i);
    if (!raw || !['/ubuntu', '/ubuntu/'].includes(raw[2])) {
      return line;
    }
    let hostname = raw[1].toLowerCase();
    if (hostname === 'azure.archive.ubuntu.com') {
      hostname = security ? 'security.ubuntu.com' : 'archive.ubuntu.com';
    } else if (!['archive.ubuntu.com', 'security.ubuntu.com'].includes(hostname)) {
      return line;
    }
    return `${prefix}https://${hostname}${raw[2]}${suffix}`;
  });
}

export function configureUbuntuAptMirrors(directory = '/etc/apt') {
  for (const name of ['apt-mirrors.txt', 'apt-security-mirrors.txt']) {
    const file = join(directory, name);
    let original;
    try {
      original = readFileSync(file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    const updated = rewriteUbuntuMirrorList(original, name === 'apt-security-mirrors.txt');
    if (updated !== original) {
      // Keep the runner image's own list so a failed canonical update can fall back to it.
      if (!existsSync(`${file}${BACKUP_SUFFIX}`)) writeFileSync(`${file}${BACKUP_SUFFIX}`, original);
      writeFileSync(file, updated);
      console.log(`Configured canonical Ubuntu HTTPS mirror: ${file}`);
    }
  }
}

export function restoreUbuntuAptMirrors(directory = '/etc/apt') {
  for (const name of ['apt-mirrors.txt', 'apt-security-mirrors.txt']) {
    const file = join(directory, name);
    if (!existsSync(`${file}${BACKUP_SUFFIX}`)) continue;
    writeFileSync(file, readFileSync(`${file}${BACKUP_SUFFIX}`, 'utf8'));
    console.log(`Restored runner image mirror list: ${file}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , flag, ...rest] = process.argv;
  if (rest.length > 0 || (flag !== undefined && flag !== '--restore')) throw new Error('This CI helper accepts only --restore.');
  if (flag === '--restore') restoreUbuntuAptMirrors();
  else configureUbuntuAptMirrors();
}
