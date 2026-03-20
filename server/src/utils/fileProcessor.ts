/**
 * File processor for multimodal AI input.
 *
 * Supported categories:
 * - Image (base64 inlineData)
 * - Audio (base64 inlineData)
 * - Document (text extraction for text/docx or PDF inlineData)
 * - Data (JSON/CSV/TSV/XML text)
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createLogger } from './logger.js';

const log = createLogger('FileProcessor');

export interface ProcessedFile {
  type: 'text' | 'image' | 'audio' | 'data';
  content: string;
  mimeType: string;
  originalName: string;
  sizeKB: number;
  base64?: string;
}

const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mp3',
  '.wav': 'audio/wav',
  '.m4a': 'audio/m4a',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.tsv': 'text/tab-separated-values',
  '.xml': 'application/xml',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] || 'application/octet-stream';
}

function getFileCategory(mimeType: string): 'image' | 'audio' | 'document' | 'data' | 'unknown' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType === 'application/pdf' || mimeType.includes('wordprocessingml') || mimeType.startsWith('text/')) {
    return 'document';
  }
  if (mimeType.includes('json') || mimeType.includes('csv') || mimeType.includes('xml')) return 'data';
  return 'unknown';
}

export async function processFile(filePath: string): Promise<ProcessedFile> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = fs.statSync(filePath);
  const sizeKB = Math.round(stat.size / 1024);
  const originalName = path.basename(filePath);
  const mimeType = getMimeType(filePath);
  const category = getFileCategory(mimeType);

  log.info(`Processing: ${originalName} (${sizeKB}KB, ${mimeType})`);

  switch (category) {
    case 'image':
      return processImage(filePath, mimeType, originalName, sizeKB);
    case 'audio':
      return processAudio(filePath, mimeType, originalName, sizeKB);
    case 'document':
      return processDocument(filePath, mimeType, originalName, sizeKB);
    case 'data':
      return processData(filePath, mimeType, originalName, sizeKB);
    default:
      return {
        type: 'text',
        content: `[Unsupported file type: ${mimeType}]`,
        mimeType,
        originalName,
        sizeKB,
      };
  }
}

function processImage(filePath: string, mimeType: string, originalName: string, sizeKB: number): ProcessedFile {
  const data = fs.readFileSync(filePath);
  return {
    type: 'image',
    content: `[Image: ${originalName} (${sizeKB}KB)]`,
    mimeType,
    originalName,
    sizeKB,
    base64: data.toString('base64'),
  };
}

function processAudio(filePath: string, mimeType: string, originalName: string, sizeKB: number): ProcessedFile {
  const data = fs.readFileSync(filePath);
  return {
    type: 'audio',
    content: `[Audio file: ${originalName} (${sizeKB}KB) - send to AI for transcription]`,
    mimeType,
    originalName,
    sizeKB,
    base64: data.toString('base64'),
  };
}

function processDocument(filePath: string, mimeType: string, originalName: string, sizeKB: number): ProcessedFile {
  let content = '';

  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    content = fs.readFileSync(filePath, 'utf-8');
  } else if (mimeType === 'application/pdf') {
    const data = fs.readFileSync(filePath);
    return {
      type: 'image',
      content: `[PDF document: ${originalName} (${sizeKB}KB)]`,
      mimeType,
      originalName,
      sizeKB,
      base64: data.toString('base64'),
    };
  } else if (mimeType.includes('wordprocessingml')) {
    content = extractDocxText(filePath);
  } else {
    content = `[Document: ${originalName} - unsupported format]`;
  }

  if (content.length > 50_000) {
    content = `${content.substring(0, 50_000)}\n...(truncated: long document)`;
  }

  return { type: 'text', content, mimeType, originalName, sizeKB };
}

function processData(filePath: string, mimeType: string, originalName: string, sizeKB: number): ProcessedFile {
  let content = '';

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');

    if (mimeType.includes('json')) {
      const parsed = JSON.parse(raw);
      content = JSON.stringify(parsed, null, 2);
    } else if (mimeType.includes('csv') || mimeType.includes('tsv')) {
      const lines = raw.split('\n');
      const header = lines[0];
      const dataLines = lines.slice(1, 101);
      content = `[${originalName} - ${lines.length - 1} rows]\n${header}\n${dataLines.join('\n')}`;
      if (lines.length > 101) {
        content += `\n...(${lines.length - 101} more rows)`;
      }
    } else {
      content = raw;
    }
  } catch (err: any) {
    content = `[Error parsing ${originalName}: ${err.message}]`;
  }

  if (content.length > 30_000) {
    content = `${content.substring(0, 30_000)}\n...(truncated)`;
  }

  return { type: 'data', content, mimeType, originalName, sizeKB };
}

function extractDocxText(filePath: string): string {
  try {
    const xml = execFileSync(
      'unzip',
      ['-p', filePath, 'word/document.xml'],
      { encoding: 'utf-8', timeout: 10_000, maxBuffer: 5 * 1024 * 1024 },
    );

    const text = xml
      .replace(/<w:p[^>]*>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{2,}/g, '\n')
      .trim();

    return text || '[Empty DOCX document]';
  } catch {
    return '[Could not extract DOCX text - install unzip for document support]';
  }
}

export function fileToGeminiPart(
  processed: ProcessedFile,
): { inlineData: { mimeType: string; data: string } } | { text: string } {
  if (processed.base64 && (processed.type === 'image' || processed.type === 'audio')) {
    return {
      inlineData: {
        mimeType: processed.mimeType,
        data: processed.base64,
      },
    };
  }
  return { text: processed.content };
}

export function getSupportedExtensions(): string[] {
  return Object.keys(EXT_TO_MIME);
}
