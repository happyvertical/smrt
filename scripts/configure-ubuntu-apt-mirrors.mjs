import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function rewriteUbuntuMirrorList(text, security = false) {
  return text.replace(/^([ \t]*)(https?:\/\/[^\s]+)([^\r\n]*)/gim, (line, prefix, token, suffix) => {
    let url;
    try {
      url = new URL(token);
    } catch {
      return line;
    }
    if (url.username || url.password || url.port || url.search || url.hash || !/^\/ubuntu\/?$/.test(url.pathname)) {
      return line;
    }
    if (url.hostname === 'azure.archive.ubuntu.com') {
      url.hostname = security ? 'security.ubuntu.com' : 'archive.ubuntu.com';
    } else if (!['archive.ubuntu.com', 'security.ubuntu.com'].includes(url.hostname)) {
      return line;
    }
    url.protocol = 'https:';
    return `${prefix}${url.href}${suffix}`;
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
