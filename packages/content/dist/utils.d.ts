import { Content } from './content';
/**
 * Converts a Content object to a string with YAML frontmatter
 *
 * @param content - Content object to convert
 * @returns String with YAML frontmatter and body content
 */
export declare function contentToString(content: Content): string;
/**
 * Converts a string with YAML frontmatter to a Content object
 *
 * @param data - String with YAML frontmatter and body content
 * @returns Object with parsed frontmatter and body content
 */
export declare function stringToContent(data: string): {
    body: string;
};
//# sourceMappingURL=utils.d.ts.map