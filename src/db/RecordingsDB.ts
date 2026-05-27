import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger';

export interface RecordingMetadata {
  filename: string;
  username: string;
  sizeMB: number;
  duration: number;
  date: string;
  thumb: string;
  messageId?: number;
  driveFileId?: string;
  isPart?: boolean;
  partIndex?: number;
  totalParts?: number;
}

export class RecordingsDB {
  private dbPath: string;

  constructor(outputDir: string) {
    this.dbPath = join(outputDir, 'recordings.json');
  }

  async getAll(): Promise<RecordingMetadata[]> {
    try {
      const data = await fs.readFile(this.dbPath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async add(recording: RecordingMetadata): Promise<void> {
    try {
      const all = await this.getAll();
      all.push(recording);
      await fs.writeFile(this.dbPath, JSON.stringify(all, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ err }, 'Failed to save recording metadata to DB');
    }
  }

  async update(filename: string, updates: Partial<RecordingMetadata>): Promise<void> {
    try {
      const all = await this.getAll();
      const idx = all.findIndex(r => r.filename === filename);
      if (idx !== -1) {
        all[idx] = { ...all[idx]!, ...updates };
        await fs.writeFile(this.dbPath, JSON.stringify(all, null, 2), 'utf-8');
      }
    } catch (err) {
      logger.error({ err }, 'Failed to update recording metadata');
    }
  }

  async getByFilename(filename: string): Promise<RecordingMetadata | undefined> {
    const all = await this.getAll();
    return all.find(r => r.filename === filename);
  }

  async getByMessageId(messageId: number): Promise<RecordingMetadata | undefined> {
    const all = await this.getAll();
    return all.find(r => r.messageId === messageId);
  }

  async getByDriveFileId(fileId: string): Promise<RecordingMetadata | undefined> {
    const all = await this.getAll();
    return all.find(r => r.driveFileId === fileId);
  }
}
