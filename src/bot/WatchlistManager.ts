import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger';

export class WatchlistManager {
  private readonly filepath = join(process.env.OUTPUT_DIR || '/app/recordings', 'watchlist.json');
  private watchlist: string[] = [];

  async load(): Promise<void> {
    try {
      const data = await fs.readFile(this.filepath, 'utf-8');
      this.watchlist = JSON.parse(data);
      logger.info({ count: this.watchlist.length }, 'Watchlist loaded successfully');
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        this.watchlist = [];
        await this.save(); // Create empty file
      } else {
        logger.error({ err }, 'Failed to load watchlist');
      }
    }
  }

  async save(): Promise<void> {
    try {
      await fs.writeFile(this.filepath, JSON.stringify(this.watchlist, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ err }, 'Failed to save watchlist');
    }
  }

  getUsers(): string[] {
    return [...this.watchlist];
  }

  async add(user: string): Promise<boolean> {
    const cleanUser = user.replace(/^@/, '').toLowerCase();
    if (this.watchlist.includes(cleanUser)) {
      return false;
    }
    this.watchlist.push(cleanUser);
    await this.save();
    return true;
  }

  async remove(user: string): Promise<boolean> {
    const cleanUser = user.replace(/^@/, '').toLowerCase();
    const initialLen = this.watchlist.length;
    this.watchlist = this.watchlist.filter((u) => u !== cleanUser);
    
    if (this.watchlist.length !== initialLen) {
      await this.save();
      return true;
    }
    return false;
  }
}
