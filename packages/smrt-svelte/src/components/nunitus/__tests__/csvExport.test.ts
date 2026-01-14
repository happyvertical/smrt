import { describe, expect, it } from 'vitest';
import { exportMessagesToCSV, messagesToCSV } from '../csvExport.js';

describe('CSV Export', () => {
  const mockMessages = [
    {
      id: 'msg-001',
      emailId: 'email-001',
      intent: 'support_request',
      category: 'support',
      sentiment: 'neutral',
      urgency: 'medium',
      senderEmail: 'user@example.com',
      senderName: 'John Doe',
      status: 'handled',
      matchedRuleName: 'Support Rule',
      isWhitelisted: false,
      isBlacklisted: false,
      requiresEscalation: false,
      createdAt: new Date('2026-01-14T10:00:00Z'),
      manualCategoryOverride: null,
      overriddenBy: null,
      overriddenAt: null,
      feedbackNotes: null,
    },
    {
      id: 'msg-002',
      emailId: 'email-002',
      intent: 'sales_inquiry',
      category: 'sales',
      sentiment: 'positive',
      urgency: 'high',
      senderEmail: 'prospect@company.com',
      senderName: 'Jane Smith',
      status: 'pending',
      matchedRuleName: 'Sales Inquiries',
      isWhitelisted: true,
      isBlacklisted: false,
      requiresEscalation: true,
      createdAt: new Date('2026-01-14T11:00:00Z'),
      manualCategoryOverride: 'sales',
      overriddenBy: 'admin-123',
      overriddenAt: new Date('2026-01-14T11:30:00Z'),
      feedbackNotes: 'High-value prospect, priority handling',
    },
  ];

  it('should convert messages to CSV format', () => {
    const csv = messagesToCSV(mockMessages);

    expect(csv).toBeTruthy();
    expect(csv).toContain('ID,Email ID,Created At');
    expect(csv).toContain('msg-001');
    expect(csv).toContain('msg-002');
    expect(csv).toContain('user@example.com');
    expect(csv).toContain('John Doe');
    expect(csv).toContain('support_request');
  });

  it('should handle empty message array', () => {
    const csv = messagesToCSV([]);
    expect(csv).toBe('');
  });

  it('should escape commas in CSV values', () => {
    const messagesWithCommas = [
      {
        ...mockMessages[0],
        senderName: 'Doe, John',
        feedbackNotes: 'This is a note, with commas',
      },
    ];

    const csv = messagesToCSV(messagesWithCommas);

    expect(csv).toContain('"Doe, John"');
    expect(csv).toContain('"This is a note, with commas"');
  });

  it('should escape quotes in CSV values', () => {
    const messagesWithQuotes = [
      {
        ...mockMessages[0],
        senderName: 'John "The Boss" Doe',
        feedbackNotes: 'He said "urgent"',
      },
    ];

    const csv = messagesToCSV(messagesWithQuotes);

    expect(csv).toContain('"John ""The Boss"" Doe"');
    expect(csv).toContain('"He said ""urgent"""');
  });

  it('should include all required columns', () => {
    const csv = messagesToCSV(mockMessages);
    const lines = csv.split('\n');
    const headers = lines[0].split(',');

    expect(headers).toContain('ID');
    expect(headers).toContain('Email ID');
    expect(headers).toContain('Intent');
    expect(headers).toContain('Category');
    expect(headers).toContain('Sentiment');
    expect(headers).toContain('Urgency');
    expect(headers).toContain('Status');
    expect(headers).toContain('Matched Rule');
    expect(headers).toContain('Manual Override');
    expect(headers).toContain('Feedback Notes');
  });

  it('should format boolean fields correctly', () => {
    const csv = messagesToCSV(mockMessages);

    // First message: not whitelisted, not escalated
    expect(csv).toContain(',No,No,No,');

    // Second message: whitelisted, escalated
    expect(csv).toContain(',Yes,No,Yes,');
  });

  it('should handle null and undefined values', () => {
    const messagesWithNulls = [
      {
        ...mockMessages[0],
        matchedRuleName: undefined,
        manualCategoryOverride: null,
        overriddenBy: null,
        overriddenAt: null,
        feedbackNotes: null,
      },
    ];

    const csv = messagesToCSV(messagesWithNulls);

    // Should not contain "null" or "undefined" strings
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });

  it('should format dates as ISO strings', () => {
    const csv = messagesToCSV(mockMessages);

    expect(csv).toContain('2026-01-14T10:00:00.000Z');
    expect(csv).toContain('2026-01-14T11:00:00.000Z');
  });

  it('should handle feedback tracking fields', () => {
    const csv = messagesToCSV(mockMessages);

    // Second message has feedback
    expect(csv).toContain('admin-123');
    expect(csv).toContain('2026-01-14T11:30:00.000Z');
    expect(csv).toContain('"High-value prospect, priority handling"');
  });
});
