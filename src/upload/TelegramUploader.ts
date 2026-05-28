import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { statSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { promises as fs, readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { RecordingsDB } from '../db/RecordingsDB';

const MAX_UPLOAD_SIZE = 1.9 * 1024 * 1024 * 1024; // 1.9 GB (safe margin under 2GB limit)

export class TelegramUploader {
  private client: TelegramClient | null = null;
  private topicCache = new Map<string, number>();
  private readonly outputDir = process.env.OUTPUT_DIR || '/app/recordings';
  private readonly topicsFile = join(this.outputDir, 'topics.json');
  private db: RecordingsDB;

  constructor() {
    this.db = new RecordingsDB(this.outputDir);
    this.loadTopics();
  }

  private async loadTopics() {
    try {
      const data = await fs.readFile(this.topicsFile, 'utf-8');
      const parsed = JSON.parse(data);
      for (const [k, v] of Object.entries(parsed)) {
        this.topicCache.set(k, Number(v));
      }
    } catch (err) {
      // Ignore if file doesn't exist
    }
  }

  private async saveTopics() {
    try {
      const obj = Object.fromEntries(this.topicCache);
      await fs.writeFile(this.topicsFile, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ err }, 'Failed to save topics cache');
    }
  }

  public async getClient(): Promise<TelegramClient> {
    if (this.client) {
      return this.client;
    }

    if (!env.telegram.apiId || !env.telegram.apiHash || !env.telegram.botToken) {
      throw new Error('Telegram API ID, Hash, and Bot Token are required');
    }

    logger.info('Initializing Telegram Bot client via MTProto');

    const session = new StringSession('');
    
    const client = new TelegramClient(session, env.telegram.apiId, env.telegram.apiHash, {
      connectionRetries: 5,
    });

    await client.start({
      botAuthToken: env.telegram.botToken,
    });

    this.client = client;
    logger.info('Telegram Bot client initialized successfully');
    
    return client;
  }

  /**
   * Get or create a forum topic. Returns the threadId and whether it was newly created.
   */
  public async getOrCreateTopic(topicName: string): Promise<{ threadId: number | undefined; isNew: boolean }> {
    if (this.topicCache.has(topicName)) {
      return { threadId: this.topicCache.get(topicName), isNew: false };
    }

    try {
      logger.info({ topicName }, 'Creating forum topic via Bot API');
      const response = await fetch(`https://api.telegram.org/bot${env.telegram.botToken}/createForumTopic`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: env.telegram.chatId,
          name: topicName
        })
      });
      const data = await response.json();
      if (data.ok) {
        const threadId = data.result.message_thread_id;
        this.topicCache.set(topicName, threadId);
        await this.saveTopics();
        return { threadId, isNew: true };
      } else {
        logger.warn({ data }, 'Failed to create forum topic. Chat might not be a forum.');
        return { threadId: undefined, isNew: false };
      }
    } catch (err) {
      logger.error({ err }, 'Error creating forum topic');
      return { threadId: undefined, isNew: false };
    }
  }

  /**
   * Send a text message into a forum topic.
   */
  public async sendTopicMessage(threadId: number | undefined, text: string): Promise<void> {
    try {
      const client = await this.getClient();
      await client.sendMessage(env.telegram.chatId, {
        message: text,
        replyTo: threadId,
        parseMode: 'html',
      });
    } catch (err) {
      logger.error({ err }, 'Failed to send topic message');
    }
  }

  /**
   * Get video duration using ffprobe, formatted as human-readable string.
   */
  private async getVideoDuration(filePath: string): Promise<string> {
    return new Promise((resolve) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'quiet',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        filePath
      ]);

      let out = '';
      ffprobe.stdout.on('data', (d) => { out += d.toString(); });
      ffprobe.on('close', () => {
        const s = parseFloat(out.trim());
        resolve(isNaN(s) ? '0:00' : this.formatSeconds(Math.round(s)));
      });
      ffprobe.on('error', () => resolve('0:00'));
    });
  }

  private async getVideoDurationSeconds(filePath: string): Promise<number> {
    return new Promise((resolve) => {
      const ffprobe = spawn('ffprobe', [
        '-v', 'quiet',
        '-show_entries', 'format=duration',
        '-of', 'csv=p=0',
        filePath
      ]);

      let out = '';
      ffprobe.stdout.on('data', (d) => { out += d.toString(); });
      ffprobe.on('close', () => {
        const s = parseFloat(out.trim());
        resolve(isNaN(s) ? 0 : Math.round(s));
      });
      ffprobe.on('error', () => resolve(0));
    });
  }

  private formatSeconds(s: number): string {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }

  private async generateThumbnail(videoPath: string, filename: string): Promise<string> {
    const thumbPath = join(this.outputDir, 'thumbs', `${filename}.jpg`);
    try { await fs.mkdir(join(this.outputDir, 'thumbs'), { recursive: true }); } catch {}
    
    if (existsSync(thumbPath)) return `/api/thumb/${filename}.jpg`;

    return new Promise((resolve) => {
      const ff = spawn('ffmpeg', ['-y', '-i', videoPath, '-ss', '00:00:05', '-vframes', '1', '-vf', 'scale=480:-1', '-q:v', '3', thumbPath]);
      ff.on('close', (code) => {
        if (code === 0) resolve(`/api/thumb/${filename}.jpg`);
        else resolve('');
      });
      ff.on('error', () => resolve(''));
    });
  }

  /**
   * Format file size as human-readable string.
   */
  private formatSize(bytes: number): string {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${Math.round(bytes / (1024 * 1024))} MB`;
  }

  /**
   * Split a large video file into segments under the Telegram upload limit using FFmpeg.
   * Returns an array of split file paths.
   */
  private async splitFile(filePath: string): Promise<string[]> {
    const dir = dirname(filePath);
    const base = basename(filePath, '.mp4');
    const pattern = join(dir, `${base}_split%03d.mp4`);

    return new Promise((resolve, reject) => {
      logger.info({ filePath, maxSizeMB: Math.round(MAX_UPLOAD_SIZE / (1024 * 1024)) }, 'Splitting large file for upload');

      const ffmpeg = spawn('ffmpeg', [
        '-y', '-i', filePath,
        '-c', 'copy',
        '-f', 'segment',
        '-segment_time', '2700',
        '-reset_timestamps', '1',
        pattern,
      ]);

      let stderr = '';
      ffmpeg.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      ffmpeg.on('close', (code) => {
        if (code === 0) {
          const files = readdirSync(dir)
            .filter(f => f.startsWith(`${base}_split`) && f.endsWith('.mp4'))
            .sort()
            .map(f => join(dir, f));
          
          logger.info({ parts: files.length }, 'File split completed');
          resolve(files);
        } else {
          logger.error({ code, stderr }, 'FFmpeg split failed');
          reject(new Error(`FFmpeg split exited with code ${code}`));
        }
      });

      ffmpeg.on('error', (err) => {
        reject(err);
      });
    });
  }

  /**
   * Send a single file as a streamable video (viewable inline in Telegram).
   */
  private async sendVideo(
    client: TelegramClient,
    filePath: string,
    threadId: number | undefined,
    caption: string
  ): Promise<number> {
    logger.info({ file: basename(filePath) }, 'Uploading as streamable video');
    const msg = await client.sendFile(env.telegram.chatId, {
      file: filePath,
      forceDocument: false,
      supportsStreaming: true,
      replyTo: threadId,
      caption,
      parseMode: 'html',
    });
    return msg.id;
  }

  async upload(filePath: string, username: string): Promise<void> {
    try {
      const client = await this.getClient();
      const stat = statSync(filePath);
      const totalSize = this.formatSize(stat.size);

      logger.info({ file: basename(filePath), size: totalSize }, 'Preparing Telegram upload');

      // Get the topic (should already exist from recording start)
      const { threadId } = await this.getOrCreateTopic(username);

      if (stat.size > MAX_UPLOAD_SIZE) {
        // File exceeds 1.9GB — split it into uploadable parts
        const parts = await this.splitFile(filePath);

        try {
          // Send header message
          await this.sendTopicMessage(threadId,
            `📹 <b>${username}</b> - ${totalSize}, sending in <b>${parts.length} parts</b>...`
          );

          for (let i = 0; i < parts.length; i++) {
            const partPath = parts[i]!;
            const partFilename = basename(partPath);
            const partStat = statSync(partPath);
            const partSizeMB = Math.round(partStat.size / (1024 * 1024));
            const partDurationStr = await this.getVideoDuration(partPath);
            const partDurationSec = await this.getVideoDurationSeconds(partPath);
            const thumbUrl = await this.generateThumbnail(partPath, partFilename.replace('.mp4', ''));

            const caption = `🎬 <b>${username}</b> - Part ${i + 1}/${parts.length}\n⏱ ${partDurationStr} · 💾 ${this.formatSize(partStat.size)}\nRecorded by @tiikstreambot`;

            const msgId = await this.sendVideo(client, partPath, threadId, caption);

            await this.db.add({
              filename: partFilename,
              username,
              sizeMB: partSizeMB,
              duration: partDurationSec,
              date: new Date().toISOString(),
              thumb: thumbUrl,
              messageId: msgId,
              isPart: true,
              partIndex: i + 1,
              totalParts: parts.length
            });

            // Clean up the split file after uploading
            try { await fs.unlink(partPath); } catch {}
          }

          // Send completion message
          await this.sendTopicMessage(threadId,
            `✅ <b>${username}</b> - All <b>${parts.length} parts</b> sent.`
          );

          logger.info({ file: basename(filePath), parts: parts.length }, 'All parts uploaded successfully');
        } finally {
          // Clean up ANY remaining split files on failure
          for (const partPath of parts) {
            try {
              if (existsSync(partPath)) {
                await fs.unlink(partPath);
                logger.debug({ file: basename(partPath) }, 'Cleaned up leaked split part');
              }
            } catch {}
          }
        }
      } else {
        // File is within limits — send directly
        const durationStr = await this.getVideoDuration(filePath);
        const durationSec = await this.getVideoDurationSeconds(filePath);
        const filename = basename(filePath);
        const thumbUrl = await this.generateThumbnail(filePath, filename.replace('.mp4', ''));
        const caption = `🎬 <b>${username}</b>\n⏱ ${durationStr} · 💾 ${totalSize}\nRecorded by @tiikstreambot`;

        const msgId = await this.sendVideo(client, filePath, threadId, caption);

        await this.db.add({
          filename,
          username,
          sizeMB: Math.round(stat.size / (1024 * 1024)),
          duration: durationSec,
          date: new Date().toISOString(),
          thumb: thumbUrl,
          messageId: msgId
        });

        logger.info({ file: filename }, 'Upload completed successfully');
      }

      // NOTE: Local file deletion is handled by the caller (TelegramBotController)
      // after both Telegram and Google Drive uploads complete.

    } catch (err) {
      logger.error({ err, file: basename(filePath) }, 'Telegram upload failed');
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.disconnect();
      this.client = null;
      logger.info('Telegram client disconnected');
    }
  }
}