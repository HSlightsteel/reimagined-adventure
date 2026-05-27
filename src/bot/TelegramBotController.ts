import { NewMessage } from 'telegram/events/index.js';
import { TelegramClient } from 'telegram';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promises as fsp } from 'node:fs';
import { TikTokRecorder } from '../recorder/TikTokRecorder';
import { TelegramUploader } from '../upload/TelegramUploader';
import { GoogleDriveUploader } from '../upload/GoogleDriveUploader';
import { WatchlistManager } from './WatchlistManager';
import { RecordingsDB } from '../db/RecordingsDB';
import { Mode } from '../enums';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { convertFlvToMp4, concatFlvToMp4 } from '../utils/ffmpeg';
import { TikTokAPI } from '../client/TikTokAPI';
import { HttpClient } from '../client/HttpClient';
import { UserNotLiveError } from '../errors/errors';

export class TelegramBotController {
  private uploader: TelegramUploader;
  private driveUploader: GoogleDriveUploader;
  private client!: TelegramClient;
  private watchlist: WatchlistManager;
  private api: TikTokAPI;
  private activeRecorders = new Map<string, TikTokRecorder>();
  private recordingStartTimes = new Map<string, Date>();
  private pollingInterval?: NodeJS.Timeout;
  private activeUploads = new Set<string>();

  constructor() {
    this.uploader = new TelegramUploader();
    this.driveUploader = new GoogleDriveUploader();
    this.watchlist = new WatchlistManager();
    const http = new HttpClient({
      proxy: env.tiktok.proxy,
      cookies: {
        sessionid_ss: env.tiktok.sessionId,
        'tt-target-idc': env.tiktok.idc,
      },
    });
    this.api = new TikTokAPI(http);
  }

  async start() {
    await this.watchlist.load();
    this.client = await this.uploader.getClient();

    this.client.addEventHandler(async (event: any) => {
      const msg = event.message;
      if (!msg || !msg.message || !msg.message.startsWith('/')) return;
      
      const chatId = msg.chatId?.toString();
      if (!chatId) return;

      const args = msg.message.split(' ');
      const cmd = args[0].toLowerCase();

      try {
        if (cmd === '/rec' && args[1]) {
          await this.handleRec(chatId, args[1]);
        } else if (cmd === '/stop') {
          await this.handleStop(chatId, args[1]);
        } else if (cmd === '/status') {
          await this.handleStatus(chatId);
        } else if (cmd === '/watch' && args[1]) {
          await this.handleWatch(chatId, args[1]);
        } else if (cmd === '/unwatch' && args[1]) {
          await this.handleUnwatch(chatId, args[1]);
        } else if (cmd === '/watchlist') {
          await this.handleWatchlist(chatId);
        } else if (cmd === '/live') {
          await this.handleLive(chatId);
        }
      } catch (err: any) {
        await this.sendMessage(chatId, `❌ Error: ${err.message}`);
      }
    }, new NewMessage({ incoming: true }));

    logger.info('Telegram Bot Controller is listening for commands');

    // PRIORITY: Start watchlist polling FIRST so no lives are missed
    this.startPolling();

    // Then handle orphaned FLV files in the background
    this.cleanupOrphanedChunks().catch(err => {
      logger.error({ err }, 'Orphan cleanup failed');
    });

    // Automatically recover and finish uploading any pending or interrupted MP4 recordings
    // Runs on startup, and then continuously every 5 minutes to automatically retry failed uploads
    const runAutoRecover = () => {
      this.autoRecoverPendingUploads().catch(err => {
        logger.error({ err }, 'Interrupted uploads auto-recovery failed');
      });
    };
    runAutoRecover();
    setInterval(runAutoRecover, 5 * 60 * 1000);
  }

  /**
   * Scan the recordings directory for orphaned .flv chunk files left behind
   * by a previous container restart. Groups chunks by username, merges sessions
   * within 10 minutes of each other, and if a user is still live, prepends the
   * orphaned chunks to the new recording for seamless stitching.
   */
  private async cleanupOrphanedChunks() {
    const outputDir = process.env.OUTPUT_DIR || '/app/recordings';

    let flvFiles: string[];
    try {
      flvFiles = readdirSync(outputDir)
        .filter(f => f.startsWith('TK_') && f.endsWith('.flv'))
        .sort();
    } catch {
      return;
    }

    if (flvFiles.length === 0) return;

    logger.info({ count: flvFiles.length }, 'Found orphaned FLV chunks, processing...');

    // Group all orphaned chunks by username with their timestamps extracted from filenames
    const userGroups = new Map<string, { path: string; mtime: number }[]>();
    for (const file of flvFiles) {
      const match = file.match(/^TK_(.+?)_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_part\d+\.flv$/);
      if (!match) continue; // Skip files that don't match our timestamp pattern

      const username = match[1]!;
      // Construct a valid ISO string: YYYY-MM-DDTHH:mm:ss.SSSZ
      const isoString = `${match[2]}T${match[3]}:${match[4]}:${match[5]}.${match[6]}Z`;
      const timestampMs = new Date(isoString).getTime();

      if (!userGroups.has(username)) userGroups.set(username, []);
      const fullPath = join(outputDir, file);
      userGroups.get(username)!.push({ path: fullPath, mtime: timestampMs });
    }

    for (const [username, chunks] of userGroups) {
      // Sort by modification time
      chunks.sort((a, b) => a.mtime - b.mtime);

      // Partition chunks into sessions where the gap between consecutive chunks is <= 10 minutes
      const sessions: { path: string; mtime: number }[][] = [];
      let currentSession = [chunks[0]!];

      for (let i = 1; i < chunks.length; i++) {
        const gap = (chunks[i]!.mtime - chunks[i - 1]!.mtime) / (1000 * 60);
        if (gap <= 10) {
          currentSession.push(chunks[i]!);
        } else {
          sessions.push(currentSession);
          currentSession = [chunks[i]!];
        }
      }
      sessions.push(currentSession);

      // Process each session separately to avoid corrupting timelines with large gaps
      for (const session of sessions) {
        const latestChunk = session[session.length - 1]!;
        const minutesSinceLatest = (Date.now() - latestChunk.mtime) / (1000 * 60);

        // If the session is within 10 minutes, we can stitch/resume with the current live stream
        if (minutesSinceLatest <= 10) {
          // Check if an active recorder is already running for this user
          if (this.activeRecorders.has(username)) {
            logger.info({ username, chunks: session.length }, 'Stitching with current active live: prepending chunks to active recorder');
            this.activeRecorders.get(username)!.prependChunks(session.map(c => c.path));
            continue; // Skip normal processing, the active recorder will stitch them at finalization
          }

          // Otherwise, check if they are live, and start recording with these chunks prepended
          try {
            const roomId = await this.api.getRoomIdFromUser(username);
            const isLive = await this.api.isRoomAlive(roomId);

            if (isLive) {
              logger.info({ username, chunks: session.length }, 'User still live — starting new recording with orphaned chunks prepended');
              await this.startRecording(username, undefined, session.map(c => c.path));
              continue; // Skip normal processing
            }
          } catch {
            // Live check failed, fall through to process as completed session
          }
        }

        // If they are not live, or the session is older, finalize the session into a single MP4
        const sessionPaths = session.map(c => c.path);
        const firstFile = sessionPaths[0]!;
        const base = firstFile.replace(/_part\d+\.flv$/, '').replace(/\.flv$/, '');
        const mp4Path = `${base}.mp4`;

        try {
          if (sessionPaths.length === 1) {
            logger.info({ file: sessionPaths[0] }, 'Converting completed orphaned FLV chunk to MP4');
            await convertFlvToMp4(sessionPaths[0]!, mp4Path);
          } else {
            logger.info({ chunks: sessionPaths.length }, 'Stitching completed orphaned FLV chunks to MP4');
            await concatFlvToMp4(sessionPaths, mp4Path);
          }

          logger.info({ mp4Path, username }, 'Orphaned chunks processed successfully, uploading');
          await this.dualUpload(mp4Path, username);
        } catch (err) {
          logger.error({ err, username }, 'Failed to process completed orphaned chunks');
        }
      }
    }

    logger.info('Orphaned chunk cleanup complete');
  }

  private async sendMessage(chatId: string, text: string) {
    try {
      await this.client.sendMessage(chatId, { message: text, parseMode: 'html' });
    } catch (err) {
      logger.error({ err, chatId }, 'Failed to send bot message');
    }
  }

  private cleanUser(user: string) {
    return user.replace(/^@/, '').toLowerCase();
  }

  private async startRecording(user: string, chatId?: string, initialChunks?: string[]) {
    const cleanUser = this.cleanUser(user);
    if (this.activeRecorders.has(cleanUser)) {
      if (chatId) await this.sendMessage(chatId, `⚠️ Already recording <b>@${cleanUser}</b>`);
      return;
    }

    if (chatId) await this.sendMessage(chatId, `🔄 Starting recording for <b>@${cleanUser}</b>...`);
    if (initialChunks?.length) {
      logger.info({ user: cleanUser, chunks: initialChunks.length }, 'Resuming recording with orphaned chunks prepended');
    }

    // Eagerly create the forum topic so it's ready before the recording finishes
    try {
      const { threadId, isNew } = await this.uploader.getOrCreateTopic(cleanUser);
      if (isNew && threadId) {
        await this.uploader.sendTopicMessage(threadId,
          `📹 All recordings for <b>@${cleanUser}</b> will be sent to this topic.`
        );
      }
    } catch (err) {
      logger.warn({ err, user: cleanUser }, 'Failed to eagerly create forum topic');
    }

    const outputDir = process.env.OUTPUT_DIR || '/app/recordings';
    const recorder = new TikTokRecorder({
      user: cleanUser,
      mode: Mode.MANUAL,
      outputDir,
      uploadAfterRecording: true,
      initialChunks,
      events: {
        onStart: ({ user, roomId }) => {
          if (chatId) this.sendMessage(chatId, `🔴 Recording started: <b>@${user}</b> (Room: ${roomId})`);
        },
        onStop: () => {
          this.activeRecorders.delete(cleanUser);
          this.recordingStartTimes.delete(cleanUser);
          if (chatId) this.sendMessage(chatId, `⏹ Recording stopped: <b>@${cleanUser}</b>`);
        },
        onComplete: (mp4Path, user) => {
          // Dual upload: Telegram + Google Drive (non-blocking)
          this.dualUpload(mp4Path, user).catch((err) => {
            logger.error({ err, user }, 'Dual upload failed');
          });
        },
        onError: (err) => {
          this.activeRecorders.delete(cleanUser);
          this.recordingStartTimes.delete(cleanUser);
          logger.error({ err, user: cleanUser }, 'Recorder error');
          if (chatId && !(err instanceof UserNotLiveError)) {
             this.sendMessage(chatId, `❌ Recording error for <b>@${cleanUser}</b>: ${err.message}`);
          } else if (chatId && err instanceof UserNotLiveError) {
             this.sendMessage(chatId, `ℹ️ <b>@${cleanUser}</b> is not live.`);
          }
        }
      }
    });

    this.activeRecorders.set(cleanUser, recorder);
    this.recordingStartTimes.set(cleanUser, new Date());
    
    // Fire and forget, error handling is in events callback
    recorder.start().catch(() => {});
  }

  private async handleRec(chatId: string, user: string) {
    await this.startRecording(user, chatId);
  }

  private async handleStop(chatId: string, user?: string) {
    if (!user) {
      if (this.activeRecorders.size === 0) {
        await this.sendMessage(chatId, `ℹ️ No active recordings to stop.`);
        return;
      }
      for (const rec of this.activeRecorders.values()) {
        rec.stop();
      }
      await this.sendMessage(chatId, `⏹ Stopped all active recordings.`);
      return;
    }
    const cleanUser = this.cleanUser(user);
    if (!this.activeRecorders.has(cleanUser)) {
      await this.sendMessage(chatId, `⚠️ <b>@${cleanUser}</b> is not currently being recorded.`);
      return;
    }
    this.activeRecorders.get(cleanUser)!.stop();
  }

  private async handleStatus(chatId: string) {
    if (this.activeRecorders.size === 0) {
      await this.sendMessage(chatId, `ℹ️ No active recordings.`);
      return;
    }
    const users = Array.from(this.activeRecorders.keys()).map(u => `🔴 <b>@${u}</b>`).join('\n');
    await this.sendMessage(chatId, `<b>Active Recordings:</b>\n${users}`);
  }

  private async handleWatch(chatId: string, user: string) {
    const cleanUser = this.cleanUser(user);
    const added = await this.watchlist.add(cleanUser);
    if (added) {
      await this.sendMessage(chatId, `✅ Added <b>@${cleanUser}</b> to watchlist.`);
    } else {
      await this.sendMessage(chatId, `⚠️ <b>@${cleanUser}</b> is already in the watchlist.`);
    }
  }

  private async handleUnwatch(chatId: string, user: string) {
    const cleanUser = this.cleanUser(user);
    const removed = await this.watchlist.remove(cleanUser);
    if (removed) {
      await this.sendMessage(chatId, `✅ Removed <b>@${cleanUser}</b> from watchlist.`);
    } else {
      await this.sendMessage(chatId, `⚠️ <b>@${cleanUser}</b> is not in the watchlist.`);
    }
  }

  private async handleWatchlist(chatId: string) {
    const users = this.watchlist.getUsers();
    if (users.length === 0) {
      await this.sendMessage(chatId, `ℹ️ Watchlist is empty.`);
      return;
    }
    const list = users.map(u => `👁 <b>@${u}</b>`).join('\n');
    await this.sendMessage(chatId, `<b>Watchlist:</b>\n${list}`);
  }

  private async handleLive(chatId: string) {
    const users = this.watchlist.getUsers();
    if (users.length === 0) {
      await this.sendMessage(chatId, `ℹ️ Watchlist is empty.`);
      return;
    }

    await this.sendMessage(chatId, `🔄 Checking live status for ${users.length} users...`);
    
    const liveUsers: string[] = [];
    for (const u of users) {
      try {
        const roomId = await this.api.getRoomIdFromUser(u);
        const isLive = await this.api.isRoomAlive(roomId);
        if (isLive) liveUsers.push(u);
      } catch(err) {
        // ignore
      }
    }

    if (liveUsers.length === 0) {
      await this.sendMessage(chatId, `ℹ️ No one from your watchlist is currently live.`);
    } else {
      const list = liveUsers.map(u => `🟢 <b>@${u}</b>`).join('\n');
      await this.sendMessage(chatId, `<b>Currently Live:</b>\n${list}`);
    }
  }

  private startPolling() {
    const intervalMinutes = process.env.INTERVAL_MINUTES ? Number(process.env.INTERVAL_MINUTES) : 1;
    const intervalMs = intervalMinutes * 60 * 1000;

    logger.info({ intervalMinutes }, 'Starting bot watchlist polling loop');

    // Initial check immediately on start
    this.checkWatchlist();

    this.pollingInterval = setInterval(() => {
      this.checkWatchlist();
    }, intervalMs);
  }

  private async checkWatchlist() {
    const users = this.watchlist.getUsers();
    for (const user of users) {
      if (this.activeRecorders.has(user)) continue;

      try {
          const roomId = await this.api.getRoomIdFromUser(user);
          const isLive = await this.api.isRoomAlive(roomId);
          if (isLive) {
            await this.sendMessage(env.telegram.chatId, `🚨 <b>@${user}</b> is live! Auto-recording started.`);
            this.startRecording(user);
          }
      } catch (err) {
          logger.debug({ user }, 'Polling check failed for user');
      }
    }
  }

  public async stop() {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    
    const recorderEntries = Array.from(this.activeRecorders.entries());
    for (const [, rec] of recorderEntries) {
      rec.stop();
    }

    if (recorderEntries.length > 0) {
      logger.info({ count: recorderEntries.length }, 'Waiting for active recordings to finish processing...');
      await new Promise(resolve => setTimeout(resolve, 15000));
    }

    await this.uploader.disconnect();
    await this.driveUploader.disconnect();
  }

  private async dualUpload(mp4Path: string, username: string): Promise<void> {
    const outputDir = process.env.OUTPUT_DIR || '/app/recordings';
    const db = new RecordingsDB(outputDir);
    const filename = mp4Path.split(/[\\/]/).pop() || '';

    this.activeUploads.add(filename);
    logger.info({ file: filename, username }, 'Starting parallel dual-upload to Telegram and Google Drive');

    try {
      let existing: any = null;
      try {
        const records = await db.getAll();
        existing = records.find(r => r.filename === filename);
      } catch {}

      let telegramSuccess = false;
      let driveSuccess = false;
      let driveFileId: string | undefined;

      if (existing && existing.messageId) {
        telegramSuccess = true;
        logger.info({ file: filename }, 'Telegram upload already completed previously, skipping.');
      }

      if (existing && existing.driveFileId) {
        driveSuccess = true;
        driveFileId = existing.driveFileId;
        logger.info({ file: filename }, 'Google Drive upload already completed previously, skipping.');
      }

      const telegramPromise = (async () => {
        if (telegramSuccess) return;
        try {
          await this.uploader.upload(mp4Path, username);
          telegramSuccess = true;
          logger.info({ file: filename, username }, 'Telegram upload completed');
        } catch (err) {
          logger.error({ err, file: filename }, 'Telegram upload failed during dual-upload');
        }
      })();

      const drivePromise = (async () => {
        if (driveSuccess) return;
        if (env.gdrive.clientId && env.gdrive.refreshToken && env.gdrive.folderId) {
          try {
            driveFileId = await this.driveUploader.upload(mp4Path, username);
            driveSuccess = true;
            logger.info({ file: filename, driveFileId, username }, 'Google Drive upload completed');
          } catch (err) {
            logger.error({ err, file: filename }, 'Google Drive upload failed during dual-upload');
          }
        } else {
          logger.warn('Google Drive not configured, skipping Drive upload');
        }
      })();

      // Run both concurrently
      await Promise.all([telegramPromise, drivePromise]);

      // If Drive succeeded, update the DB now that we are absolutely certain
      // Telegram has finished adding the initial entry. (Fixes race condition)
      if (driveSuccess && driveFileId) {
        await db.update(filename, { driveFileId });
      }

      const hasDrive = !!(env.gdrive.clientId && env.gdrive.refreshToken && env.gdrive.folderId);

      // 3. Delete local file only if all configured uploads succeeded
      if (telegramSuccess && (!hasDrive || driveSuccess)) {
        try {
          await fsp.unlink(mp4Path);
          logger.info({ file: filename }, 'Local MP4 deleted after successful upload(s)');
        } catch (err) {
          logger.warn({ err, file: filename }, 'Failed to delete local MP4');
        }
      } else {
        logger.warn({ file: filename, telegramSuccess, driveSuccess }, 'One or more uploads failed, keeping local MP4');
      }
    } finally {
      this.activeUploads.delete(filename);
    }
  }

  // ── Public getters for API server ──

  public getActiveRecordings(): Array<{ username: string; startedAt: string; durationSeconds: number }> {
    const now = Date.now();
    return Array.from(this.activeRecorders.keys()).map(user => {
      const startedAt = this.recordingStartTimes.get(user) || new Date();
      return {
        username: user,
        startedAt: startedAt.toISOString(),
        durationSeconds: Math.round((now - startedAt.getTime()) / 1000),
      };
    });
  }

  public getWatchlistUsers(): string[] {
    return this.watchlist.getUsers();
  }

  public getWatchlistManager(): WatchlistManager {
    return this.watchlist;
  }

  public getTikTokAPI(): TikTokAPI {
    return this.api;
  }

  public isRecording(user: string): boolean {
    return this.activeRecorders.has(user.replace(/^@/, '').toLowerCase());
  }

  public async publicStartRecording(user: string): Promise<void> {
    await this.startRecording(user);
  }

  public publicStopRecording(user: string): boolean {
    const cleanUser = user.replace(/^@/, '').toLowerCase();
    if (!this.activeRecorders.has(cleanUser)) return false;
    this.activeRecorders.get(cleanUser)!.stop();
    return true;
  }

  public getUploader(): TelegramUploader {
    return this.uploader;
  }

  public getDriveUploader(): GoogleDriveUploader {
    return this.driveUploader;
  }

  public getActiveUploads(): string[] {
    return Array.from(this.activeUploads);
  }

  /**
   * Scan recordings directory for any .mp4 files that are NOT in the database,
   * or are in the database but have missing messageId or driveFileId, and
   * automatically queue them for dual-upload.
   */
  private async autoRecoverPendingUploads() {
    const outputDir = process.env.OUTPUT_DIR || '/app/recordings';
    const db = new RecordingsDB(outputDir);
    let recordings = [];
    try {
      recordings = await db.getAll();
    } catch {
      return;
    }

    let files: string[];
    try {
      files = readdirSync(outputDir)
        .filter(f => f.startsWith('TK_') && f.endsWith('.mp4') && !f.endsWith('_merged.mp4') && !f.includes('_split'))
        .sort();
    } catch {
      return;
    }

    if (files.length === 0) return;

    logger.info({ count: files.length }, 'Scanning for pending or interrupted uploads...');

    for (const file of files) {
      const filename = file;
      const match = filename.match(/^TK_(.+?)_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
      if (!match) continue;
      const username = match[1]!;

      // Find in DB
      const existing = recordings.find(r => r.filename === filename);
      const hasDrive = !!(env.gdrive.clientId && env.gdrive.refreshToken && env.gdrive.folderId);
      
      const needsTelegram = !existing || !existing.messageId;
      const needsDrive = hasDrive && (!existing || !existing.driveFileId);

      if ((needsTelegram || needsDrive) && !this.activeUploads.has(filename)) {
        logger.info({ file: filename, username, needsTelegram, needsDrive }, 'Found pending/interrupted upload. Queuing for dual-upload...');
        
        // If not in DB, add it with preliminary data so it shows up in miniapp
        if (!existing) {
          try {
            const stats = statSync(join(outputDir, filename));
            await db.add({
              filename,
              username,
              sizeMB: Math.round(stats.size / 1024 / 1024),
              duration: 0,
              date: new Date(stats.mtime).toISOString(),
              thumb: '',
              isPart: false
            });
          } catch (err) {
            logger.error({ err, file: filename }, 'Failed to write preliminary DB entry for recovery');
          }
        }

        // Trigger dual-upload in background
        const fullPath = join(outputDir, filename);
        this.dualUpload(fullPath, username).catch((err) => {
          logger.error({ err, file: filename }, 'Auto-recovery dual-upload failed');
        });
      }
    }
  }
}
