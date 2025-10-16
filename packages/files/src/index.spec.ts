// index.test.ts

import * as fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import * as path from 'node:path';
import { getTempDirectory } from '@have/utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  download,
  downloadFileWithCache,
  ensureDirectoryExists,
  isDirectory,
  isFile,
  listFiles,
  upload,
} from './index';

// Mock fs modulesq
// vi.mock('node:fs');
// vi.mock('node:fs/promises');

describe('File utilities', () => {
  let tmpDir: string;
  let server: Server;
  let serverUrl: string;

  beforeEach(() => {
    // Create a unique temporary directory for each test
    tmpDir = path.join(getTempDirectory(), 'file-utils-test');
    fs.mkdirSync(tmpDir, { recursive: true });

    // Create and start test server
    server = createServer((req, res) => {
      if (req.method === 'PUT' && req.url === '/upload') {
        let _data = '';
        req.on('data', (chunk) => {
          _data += chunk;
        });
        req.on('end', () => {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Upload successful');
        });
      } else if (req.method === 'PUT') {
        // Explicitly handle failed uploads
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Upload failed');
      } else if (req.url === '/test.txt') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Test content');
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });

    return new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          serverUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(() => {
    // Clean up temporary directory and server after each test
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  describe('isFile', () => {
    it('should return stat when path is a file', () => {
      const filePath = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(filePath, 'test content');

      const result = isFile(filePath);
      expect(result).toBeTruthy();
      // expect(isDirectory(result?.)).toBe(false);
    });

    it('should return false when path is a directory', () => {
      const dirPath = path.join(tmpDir, 'test-dir');
      fs.mkdirSync(dirPath);

      const result = isFile(dirPath);
      expect(result).toBe(false);
    });

    it('should return false when path does not exist', () => {
      const result = isFile(path.join(tmpDir, 'non-existent.txt'));
      expect(result).toBe(false);
    });
  });

  describe('isDirectory', () => {
    it('should return true when path is a directory', () => {
      const dirPath = path.join(tmpDir, 'test-dir');
      fs.mkdirSync(dirPath);

      const result = isDirectory(dirPath);
      expect(result).toBe(true);
    });

    it('should throw error when path exists but is not a directory', () => {
      const filePath = path.join(tmpDir, 'test.txt');
      fs.writeFileSync(filePath, 'test content');

      expect(() => isDirectory(filePath)).toThrow();
    });

    it('should return false when path does not exist', () => {
      const result = isDirectory(path.join(tmpDir, 'non-existent-dir'));
      expect(result).toBe(false);
    });
  });

  describe('ensureDirectoryExists', () => {
    it('should create directory if it does not exist', async () => {
      const dirPath = path.join(tmpDir, 'new-dir');
      await ensureDirectoryExists(dirPath);
      expect(fs.existsSync(dirPath)).toBe(true);
      expect(fs.statSync(dirPath).isDirectory()).toBe(true);
    });

    it('should not throw if directory already exists', async () => {
      const dirPath = path.join(tmpDir, 'existing-dir');
      fs.mkdirSync(dirPath);

      // Should complete without throwing
      await expect(ensureDirectoryExists(dirPath)).resolves.toBeUndefined();
      // Directory should still exist
      expect(fs.existsSync(dirPath)).toBe(true);
    });
  });

  describe('listFiles', () => {
    it('should list all files when no match pattern is provided', async () => {
      const files = ['file1.txt', 'file2.jpg', 'file3.png'];
      for (const file of files) {
        fs.writeFileSync(path.join(tmpDir, file), 'test content');
      }

      const result = await listFiles(tmpDir);
      expect(result.sort()).toEqual(files.sort());
    });

    it('should filter files based on match pattern', async () => {
      const files = ['file1.txt', 'file2.jpg', 'file3.png'];
      for (const file of files) {
        fs.writeFileSync(path.join(tmpDir, file), 'test content');
      }

      const result = await listFiles(tmpDir, { match: /\.txt$/ });
      expect(result).toEqual(['file1.txt']);
    });
  });

  describe('upload', () => {
    it('should upload data successfully', async () => {
      const response = await upload(`${serverUrl}/upload`, 'test-data');
      expect(response.ok).toBe(true);
    });

    it('should throw error on failed upload', async () => {
      await expect(
        upload(`${serverUrl}/nonexistent`, 'test-data'),
      ).rejects.toThrow();
    });
  });

  describe('download', () => {
    it('should download file successfully', async () => {
      const localPath = path.join(tmpDir, 'test.txt');
      const _downloaded = await download(`${serverUrl}/test.txt`, localPath);
      expect(fs.existsSync(localPath)).toBe(true);
    });

    it('should throw error on failed download', async () => {
      await expect(
        download(`${serverUrl}/nonexistent`, path.join(tmpDir, 'nonexistent')),
      ).rejects.toThrow();
    });
  });

  describe('downloadFileWithCache', () => {
    it('should download and cache a text file', async () => {
      const targetPath = path.join(tmpDir, 'test.txt');

      await downloadFileWithCache(`${serverUrl}/test.txt`, targetPath);
      // console.log('targetPath', targetPath);
      // Verify the file exists and has content
      expect(fs.existsSync(targetPath)).toBe(true);
    });
  });
});
