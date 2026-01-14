/**
 * CSV Export Utilities for Nunitus Dashboard
 *
 * Provides functions to export processed messages to CSV format
 */

interface ProcessedMessage {
  id: string;
  emailId: string;
  intent: string;
  category: string;
  sentiment: string;
  urgency: string;
  senderEmail: string;
  senderName: string;
  status: string;
  matchedRuleName?: string;
  isWhitelisted: boolean;
  isBlacklisted: boolean;
  requiresEscalation: boolean;
  createdAt: Date;
  manualCategoryOverride: string | null;
  overriddenBy: string | null;
  overriddenAt: Date | null;
  feedbackNotes: string | null;
}

/**
 * Convert an array of processed messages to CSV string
 */
export function messagesToCSV(messages: ProcessedMessage[]): string {
  if (messages.length === 0) {
    return '';
  }

  // Define CSV headers
  const headers = [
    'ID',
    'Email ID',
    'Created At',
    'Sender Name',
    'Sender Email',
    'Intent',
    'Category',
    'Sentiment',
    'Urgency',
    'Status',
    'Matched Rule',
    'Whitelisted',
    'Blacklisted',
    'Escalated',
    'Manual Override',
    'Overridden By',
    'Overridden At',
    'Feedback Notes',
  ];

  // Convert messages to CSV rows
  const rows = messages.map((msg) => [
    escapeCSV(msg.id),
    escapeCSV(msg.emailId),
    formatDate(msg.createdAt),
    escapeCSV(msg.senderName),
    escapeCSV(msg.senderEmail),
    escapeCSV(msg.intent),
    escapeCSV(msg.category),
    escapeCSV(msg.sentiment),
    escapeCSV(msg.urgency),
    escapeCSV(msg.status),
    escapeCSV(msg.matchedRuleName || ''),
    msg.isWhitelisted ? 'Yes' : 'No',
    msg.isBlacklisted ? 'Yes' : 'No',
    msg.requiresEscalation ? 'Yes' : 'No',
    escapeCSV(msg.manualCategoryOverride || ''),
    escapeCSV(msg.overriddenBy || ''),
    msg.overriddenAt ? formatDate(msg.overriddenAt) : '',
    escapeCSV(msg.feedbackNotes || ''),
  ]);

  // Combine headers and rows
  const csvContent = [
    headers.join(','),
    ...rows.map((row) => row.join(',')),
  ].join('\n');

  return csvContent;
}

/**
 * Escape CSV field value (handle commas, quotes, newlines)
 */
function escapeCSV(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }

  const stringValue = String(value);

  // If value contains comma, quote, or newline, wrap in quotes and escape existing quotes
  if (
    stringValue.includes(',') ||
    stringValue.includes('"') ||
    stringValue.includes('\n')
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

/**
 * Format date for CSV export
 */
function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toISOString();
}

/**
 * Download CSV file to user's browser
 */
export function downloadCSV(
  content: string,
  filename: string = 'nunitus-export.csv',
): void {
  // Create blob
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });

  // Create download link
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);

  link.setAttribute('href', url);
  link.setAttribute('download', filename);
  link.style.visibility = 'hidden';

  // Trigger download
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  // Clean up
  URL.revokeObjectURL(url);
}

/**
 * Export messages to CSV and trigger download
 */
export function exportMessagesToCSV(
  messages: ProcessedMessage[],
  filename?: string,
): void {
  const csv = messagesToCSV(messages);

  if (!csv) {
    alert('No messages to export');
    return;
  }

  const defaultFilename = `nunitus-messages-${new Date().toISOString().split('T')[0]}.csv`;
  downloadCSV(csv, filename || defaultFilename);
}
