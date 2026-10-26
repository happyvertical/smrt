import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

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
      writeFileSync(file, updated);
      console.log(`Configured canonical Ubuntu HTTPS mirror: ${file}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) throw new Error('This CI helper accepts no arguments.');
  configureUbuntuAptMirrors();
}
