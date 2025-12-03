/**
 * Simple Markdown Renderer
 *
 * Converts basic markdown to HTML for article bodies.
 * For more complex needs, consider using a library like marked or remark.
 */

export function renderMarkdown(md: string): string {
  if (!md) return '';

  return md
    // Escape HTML entities
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Headers
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // Bold and italic
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    // Lists
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>')
    // Paragraphs
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/^/, '<p>')
    .replace(/$/, '</p>')
    // Clean up
    .replace(/<p><\/p>/g, '')
    .replace(/<p>(<[hu])/g, '$1')
    .replace(/(<\/[hu]l>)<\/p>/g, '$1');
}
