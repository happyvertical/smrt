import yaml from 'yaml';
import type { Content } from './content';

/**
 * Converts a Content object to a string with YAML frontmatter
 *
 * @param content - Content object to convert
 * @returns String with YAML frontmatter and body content
 */
export function contentToString(content: Content) {
  const { body, ...frontmatter } = content;
  const separator = '---';
  const frontmatterYAML = yaml.stringify(frontmatter);
  return `${separator}\n${frontmatterYAML}\n${separator}\n${body}`;
}

/**
 * Converts a string with YAML frontmatter to a Content object
 *
 * @param data - String with YAML frontmatter and body content
 * @returns Object with parsed frontmatter and body content
 */
export function stringToContent(data: string) {
  const separator = '---';
  const frontmatterStart = data.indexOf(separator);

  let frontmatter = {};
  let body = data;

  if (frontmatterStart !== -1) {
    const frontmatterEnd = data.indexOf(
      separator,
      frontmatterStart + separator.length,
    );

    if (frontmatterEnd !== -1) {
      const frontmatterYAML = data
        .substring(frontmatterStart + separator.length, frontmatterEnd)
        .trim();
      // yaml.parse() THROWS on malformed YAML — `|| {}` only covers an
      // empty/null parse. Wrap so a bad frontmatter block degrades to "no
      // frontmatter" instead of crashing the caller (#1387).
      try {
        frontmatter = yaml.parse(frontmatterYAML) || {};
      } catch {
        frontmatter = {};
      }
      body = data.substring(frontmatterEnd + separator.length).trim();
    }
  }

  return {
    ...frontmatter,
    body,
  };
}
