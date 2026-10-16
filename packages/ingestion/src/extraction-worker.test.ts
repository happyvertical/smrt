import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getOCR: vi.fn(() => ({
    performOCR: vi.fn(),
    getProvidersInfo: vi.fn(async () => []),
  })),
  extractWithProviders: vi.fn(async () => ({
    status: 'complete',
    segments: [],
    errors: [],
  })),
}));

vi.mock('@happyvertical/ocr', () => ({
  getOCR: mocks.getOCR,
  UnlimitedOCRProvider: vi.fn(),
}));
vi.mock('@happyvertical/ai', () => ({ getAI: vi.fn() }));
vi.mock('@happyvertical/pdf', () => ({ getPDFReader: vi.fn() }));
vi.mock('@happyvertical/speech', () => ({ getTranscriber: vi.fn() }));
vi.mock('./extraction-providers.js', () => ({
  extractWithProviders: mocks.extractWithProviders,
}));

describe('extraction worker OCR provider routing', () => {
  it('passes a paddleocr-vl identity and its options through the getOCR factory', async () => {
    const originalSend = process.send;
    const originalExit = process.exit;
    process.send = ((_message: unknown, callback?: () => void) => {
      callback?.();
      return true;
    }) as typeof process.send;
    process.exit = (() => undefined) as unknown as typeof process.exit;
    const options = {
      baseUrl: 'http://127.0.0.1:8118/v1',
      model: 'PaddleOCR-VL-1.6',
    };
    await import('./extraction-worker.js');
    process.emit(
      'message' as never,
      {
        request: {
          evidence: { mediaType: 'image/png' },
          limits: { maxBytes: 1024, timeoutMs: 1000 },
        },
        configuration: {
          imageMode: 'ocr',
          ocr: {
            identity: {
              provider: 'paddleocr-vl',
              model: 'PaddleOCR-VL-1.6',
              version: 'test',
            },
            options,
          },
        },
      } as never,
    );
    await vi.waitFor(() =>
      expect(mocks.extractWithProviders).toHaveBeenCalled(),
    );
    expect(mocks.getOCR).toHaveBeenCalledWith({
      provider: 'paddleocr-vl',
      fallbackProviders: [],
      providerConfig: { 'paddleocr-vl': options },
    });
    process.send = originalSend;
    process.exit = originalExit;
  });
});
