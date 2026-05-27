import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger';
import type { TelegramBotController } from '../bot/TelegramBotController';
import type { GoogleDriveUploader } from '../upload/GoogleDriveUploader';
import { RecordingsDB } from '../db/RecordingsDB';
import { env } from '../config/env';

// Silence harmless gramjs CastError spam that fills logs and slows down execution
const originalConsoleError = console.error;
console.error = function (...args: any[]) {
  if (args[0] && typeof args[0] === 'object' && args[0].name === 'CastError' && args[0].message?.includes('expected bigInt but received')) {
    return;
  }
  originalConsoleError.apply(console, args);
};

export class ApiServer {
  private server;
  private miniappDir: string;
  private recordingsDir: string;
  private thumbDir: string;
  private db: RecordingsDB;
  private driveUploader: GoogleDriveUploader | null;
  private cachedLiveResults: Array<{ username: string; isLive: boolean; isRecording: boolean }> = [];
  private lastLiveCheck: number = 0;

  constructor(private controller: TelegramBotController, driveUploader?: GoogleDriveUploader) {
    this.miniappDir = join(process.cwd(), 'miniapp');
    this.recordingsDir = process.env.OUTPUT_DIR || '/app/recordings';
    this.thumbDir = join(this.recordingsDir, '.thumbs');
    this.db = new RecordingsDB(this.recordingsDir);
    this.driveUploader = driveUploader || null;
    this.ensureThumbDir();
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  private async ensureThumbDir() {
    try { await mkdir(this.thumbDir, { recursive: true }); } catch {}
  }

  async start(port: number): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(port, '0.0.0.0', () => {
        logger.info({ port }, 'API server listening');
        resolve();
      });
    });
  }

  stop(): void { this.server.close(); }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const path = url.pathname;

    try {
      if (path === '/miniapp' || path === '/miniapp/') {
        return await this.serveFile(res, join(this.miniappDir, 'index.html'), 'text/html');
      }
      if (path === '/miniapp/style.css') {
        return await this.serveFile(res, join(this.miniappDir, 'style.css'), 'text/css');
      }
      if (path === '/miniapp/app.js') {
        return await this.serveFile(res, join(this.miniappDir, 'app.js'), 'application/javascript');
      }

      // Avatar proxy
      if (path.startsWith('/api/avatar/')) {
        const username = path.replace('/api/avatar/', '').replace(/[^a-zA-Z0-9_.]/g, '');
        if (!username) return this.json(res, { error: 'Invalid' }, 400);
        return await this.serveAvatar(res, username);
      }

      // Thumbnail endpoint
      if (path.startsWith('/api/thumb/')) {
        const filename = path.replace('/api/thumb/', '');
        if (filename.includes('..')) return this.json(res, { error: 'Invalid' }, 400);
        return await this.serveThumbnail(res, filename);
      }

      // Video streaming
      if (path.startsWith('/recordings/')) {
        const filename = path.replace('/recordings/', '');
        if (filename.includes('..') || filename.includes('/')) return this.json(res, { error: 'Invalid' }, 400);
        return await this.serveVideo(req, res, join(this.recordingsDir, filename));
      }

      // Live proxy
      if (path.startsWith('/api/stream/')) {
        const username = path.replace('/api/stream/', '').replace(/[^a-zA-Z0-9_.]/g, '');
        if (!username) return this.json(res, { error: 'Invalid' }, 400);

        const api = this.controller.getTikTokAPI();
        try {
          const roomId = await api.getRoomIdFromUser(username);
          const liveUrl = await api.getLiveStreamUrl(roomId);
          
          res.writeHead(200, {
            'Content-Type': 'video/x-flv',
            'Connection': 'keep-alive',
            'Transfer-Encoding': 'chunked',
            'Access-Control-Allow-Origin': '*'
          });

          const stream = await api.http.getStream(liveUrl);
          const readable = Readable.fromWeb(stream as never);
          readable.pipe(res);
          
          req.on('close', () => { readable.destroy(); });
          return;
        } catch (err) {
          logger.error({ err, username }, 'Failed to proxy live stream');
          return this.json(res, { error: 'Stream not available' }, 404);
        }
      }

      if (path === '/api/status' && req.method === 'GET') {
        return this.json(res, {
          activeRecordings: this.controller.getActiveRecordings(),
          activeUploads: this.controller.getActiveUploads()
        });
      }
      if (path === '/api/watchlist' && req.method === 'GET') {
        return this.json(res, { users: this.controller.getWatchlistUsers() });
      }
      if (path === '/api/watchlist' && req.method === 'POST') {
        const body = await this.readBody(req);
        const username = body.username?.replace(/^@/, '').toLowerCase();
        if (!username) return this.json(res, { error: 'username required' }, 400);
        const added = await this.controller.getWatchlistManager().add(username);
        return this.json(res, { success: added, username });
      }
      if (path.startsWith('/api/watchlist/') && req.method === 'DELETE') {
        const username = path.split('/api/watchlist/')[1]!;
        const removed = await this.controller.getWatchlistManager().remove(username);
        return this.json(res, { success: removed, username });
      }
      if (path === '/api/live' && req.method === 'GET') {
        const now = Date.now();
        if (now - this.lastLiveCheck > 60000) {
          const users = this.controller.getWatchlistUsers();
          const api = this.controller.getTikTokAPI();
          const results: Array<{ username: string; isLive: boolean; isRecording: boolean }> = [];
          for (const user of users) {
            try {
              const roomId = await api.getRoomIdFromUser(user);
              const isLive = await api.isRoomAlive(roomId);
              results.push({ username: user, isLive, isRecording: this.controller.isRecording(user) });
            } catch {
              results.push({ username: user, isLive: false, isRecording: this.controller.isRecording(user) });
            }
          }
          this.cachedLiveResults = results;
          this.lastLiveCheck = now;
        } else {
          // Update the isRecording status dynamically since it's local and instantaneous
          this.cachedLiveResults.forEach(r => {
            r.isRecording = this.controller.isRecording(r.username);
          });
        }
        return this.json(res, { users: this.cachedLiveResults });
      }
      if (path.startsWith('/api/rec/') && req.method === 'POST') {
        const username = path.split('/api/rec/')[1]!;
        await this.controller.publicStartRecording(username);
        return this.json(res, { success: true, username });
      }
      if (path.startsWith('/api/stop/') && req.method === 'POST') {
        const username = path.split('/api/stop/')[1]!;
        const stopped = this.controller.publicStopRecording(username);
        return this.json(res, { success: stopped, username });
      }
      if (path === '/api/recordings' && req.method === 'GET') {
        return this.json(res, await this.listRecordings());
      }
      if (path.startsWith('/api/recordings/') && req.method === 'GET') {
        const username = path.split('/api/recordings/')[1]!;
        const all = await this.listRecordings();
        return this.json(res, { recordings: all.recordings.filter(r => r.username === username) });
      }
      if (path === '/api/search' && req.method === 'POST') {
        const body = await this.readBody(req);
        const username = body.username?.replace(/^@/, '').toLowerCase();
        if (!username) return this.json(res, { error: 'username required' }, 400);
        const api = this.controller.getTikTokAPI();
        try {
          const roomId = await api.getRoomIdFromUser(username);
          const isLive = await api.isRoomAlive(roomId);
          return this.json(res, { exists: true, username, isLive, roomId });
        } catch {
          return this.json(res, { exists: false, username, isLive: false });
        }
      }

      if (path.startsWith('/api/telegram/video/') && req.method === 'GET') {
        const messageId = parseInt(path.split('/api/telegram/video/')[1]!, 10);
        if (isNaN(messageId)) {
          this.json(res, { error: 'Invalid message ID' }, 400);
          return;
        }
        await this.serveTelegramVideo(req, res, messageId);
        return;
      }

      if (path.startsWith('/api/drive/video/') && req.method === 'GET') {
        const fileId = path.split('/api/drive/video/')[1]!;
        if (!fileId || fileId.includes('..')) {
          this.json(res, { error: 'Invalid file ID' }, 400);
          return;
        }
        await this.serveDriveVideo(req, res, fileId);
        return;
      }

      if (path === '/api/drive/sync' && req.method === 'POST') {
        return await this.syncDriveToDb(res);
      }

      this.json(res, { error: 'Not found' }, 404);
    } catch (err: any) {
      logger.error({ err, path }, 'API request failed');
      this.json(res, { error: err.message || 'Internal server error' }, 500);
    }
  }

  /** Fetch and cache TikTok profile picture */
  private async serveAvatar(res: ServerResponse, username: string): Promise<void> {
    const cachePath = join(this.thumbDir, `av_${username}.jpg`);
    if (existsSync(cachePath)) {
      const data = await readFile(cachePath);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
      return;
    }
    try {
      const resp = await fetch(`https://www.tiktok.com/@${username}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' }
      });
      const html = await resp.text();
      const match = html.match(/"avatarThumb":"([^"]+)"/) || html.match(/og:image[^>]*content="([^"]+)"/);
      if (match && match[1]) {
        const imgUrl = match[1].replace(/\\u002F/g, '/');
        const imgResp = await fetch(imgUrl);
        const buf = Buffer.from(await imgResp.arrayBuffer());
        await writeFile(cachePath, buf);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        res.end(buf);
        return;
      }
    } catch (err) { logger.warn({ err, username }, 'Avatar fetch failed'); }
    res.writeHead(204); res.end();
  }

  // ── Helpers ──

  private json(res: ServerResponse, data: any, status = 200): void {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private async readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
    });
  }

  private async serveFile(res: ServerResponse, filePath: string, contentType: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');
      res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
      res.end(content);
    } catch { this.json(res, { error: 'File not found' }, 404); }
  }

  /** Generate and serve a video thumbnail (cached) */
  private async serveThumbnail(res: ServerResponse, filename: string): Promise<void> {
    const mp4Name = filename.replace('.jpg', '');
    const thumbPath = join(this.thumbDir, `${mp4Name}.jpg`);
    const videoPath = join(this.recordingsDir, mp4Name);

    // Serve from cache if exists
    if (existsSync(thumbPath)) {
      const data = await readFile(thumbPath);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
      return;
    }

    // Generate thumbnail with ffmpeg
    if (!existsSync(videoPath)) { this.json(res, { error: 'Video not found' }, 404); return; }

    try {
      await new Promise<void>((resolve, reject) => {
        const ff = spawn('ffmpeg', ['-y', '-i', videoPath, '-ss', '00:00:05', '-vframes', '1', '-vf', 'scale=480:-1', '-q:v', '3', thumbPath]);
        ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
        ff.on('error', reject);
      });
      const data = await readFile(thumbPath);
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    } catch {
      res.writeHead(204); res.end();
    }
  }

  private async serveVideo(req: IncomingMessage, res: ServerResponse, filePath: string): Promise<void> {
    try {
      const stats = await stat(filePath);
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0]!, 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${stats.size}`,
          'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Content-Type': 'video/mp4',
        });
        createReadStream(filePath, { start, end }).pipe(res);
      } else {
        res.writeHead(200, { 'Content-Length': stats.size, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' });
        createReadStream(filePath).pipe(res);
      }
    } catch { this.json(res, { error: 'File not found' }, 404); }
  }

  private async serveTelegramVideo(req: IncomingMessage, res: ServerResponse, messageId: number): Promise<void> {
    try {
      const uploader = this.controller.getUploader();
      const client = await uploader.getClient();
      
      const messages = await client.getMessages(process.env.TELEGRAM_CHAT_ID!, { ids: messageId });
      const message = messages[0];

      if (!message || !message.media) {
        this.json(res, { error: 'Video not found in Telegram' }, 404);
        return;
      }

      const size = Number((message.media as any)?.document?.size || 0);
      if (size === 0) {
        this.json(res, { error: 'Invalid video size' }, 404);
        return;
      }

      const range = req.headers.range;

      // Handle client disconnects to prevent leaking downloads and causing Flood Waits
      let isAborted = false;
      req.on('close', () => {
        isAborted = true;
      });

      const bigInt = require('big-integer');

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0]!, 10);
        const end = parts[1] ? parseInt(parts[1], 10) : size - 1;

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': 'video/mp4',
        });

        try {
          const stream = client.iterDownload({
            file: message.media,
            offset: bigInt(start),
            limit: end - start + 1,
            requestSize: 524288, // 512KB chunks are much more stable for Telegram MTProto
          });

          for await (const chunk of stream) {
            if (isAborted) break;
            res.write(chunk);
          }
        } catch (streamErr) {
          logger.warn({ streamErr, messageId }, 'Telegram stream interrupted during playback');
        } finally {
          if (!isAborted && !res.writableEnded) res.end();
        }
      } else {
        res.writeHead(200, {
          'Content-Length': size,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes'
        });

        try {
          const stream = client.iterDownload({
            file: message.media,
            offset: bigInt(0),
            requestSize: 524288,
          });

          for await (const chunk of stream) {
            if (isAborted) break;
            res.write(chunk);
          }
        } catch (streamErr) {
          logger.warn({ streamErr, messageId }, 'Telegram stream interrupted during playback');
        } finally {
          if (!isAborted && !res.writableEnded) res.end();
        }
      }
    } catch (err: any) {
      logger.error({ err, messageId }, 'Telegram video API request failed');
      if (!res.headersSent) {
        this.json(res, { error: err.message || 'Internal server error' }, 500);
      } else {
        res.end();
      }
    }
  }

  private async listRecordings(): Promise<{ recordings: any[] }> {
    try {
      const all = await this.db.getAll();
      all.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      return { recordings: all };
    } catch { return { recordings: [] }; }
  }

  private async syncDriveToDb(res: ServerResponse): Promise<void> {
    if (!this.driveUploader) {
      this.json(res, { error: 'Google Drive not configured' }, 503);
      return;
    }
    try {
      const drive = (this.driveUploader as any).getDriveClient();

      // Dynamically fetch all creator subfolders under the root Google Drive folder
      logger.info({ folderId: env.gdrive.folderId }, 'Fetching subfolders from Google Drive root');
      const foldersResp = await drive.files.list({
        q: `'${env.gdrive.folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id, name)',
        pageSize: 1000
      });

      const folders = foldersResp.data.files || [];
      if (folders.length === 0) {
        logger.warn('No subfolders found under Google Drive root folder');
        this.json(res, { success: true, added: 0, updated: 0, users: [] });
        return;
      }

      // Sync and populate the internal/local folder caches so the uploader knows about them for future uploads too
      const foldersMap: Record<string, string> = {};
      for (const folder of folders) {
        if (folder.name && folder.id) {
          foldersMap[folder.name] = folder.id;
          (this.driveUploader as any).folderCache.set(folder.name, folder.id);
        }
      }
      
      // Save cache updates to drive_folders.json
      const foldersPath = join(this.recordingsDir, 'drive_folders.json');
      await writeFile(foldersPath, JSON.stringify(foldersMap, null, 2), 'utf-8');

      const existing = await this.db.getAll();
      const existingIds = new Set(existing.map((r: any) => r.driveFileId).filter(Boolean));

      let added = 0;
      let updated = 0;
      const usernames: string[] = [];

      for (const folder of folders) {
        const username = folder.name;
        const folderId = folder.id;
        if (!username || !folderId) continue;
        usernames.push(username);

        logger.info({ username, folderId }, 'Scanning Google Drive subfolder for videos...');
        const resp = await drive.files.list({
          q: `'${folderId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`,
          fields: 'files(id, name, size, createdTime)',
          pageSize: 1000,
          orderBy: 'createdTime desc'
        });
        const files = resp.data.files || [];

        for (const file of files) {
          if (!file.name?.endsWith('.mp4')) continue;

          if (existingIds.has(file.id)) continue;

          // Check if we have a record for this filename without a Drive ID
          const byName = existing.find((r: any) => r.filename === file.name && !r.driveFileId);
          if (byName) {
            await this.db.update(file.name, { driveFileId: file.id });
            updated++;
          } else {
            const sizeMB = Math.round(Number(file.size || 0) / (1024 * 1024));
            await this.db.add({
              filename: file.name,
              username,
              sizeMB,
              duration: 0,
              date: file.createdTime || new Date().toISOString(),
              thumb: '',
              driveFileId: file.id,
              isPart: false
            });
            added++;
          }
        }
      }

      logger.info({ added, updated, usernames }, 'Dynamic Drive sync completed successfully');
      this.json(res, { success: true, added, updated, users: usernames });
    } catch (err: any) {
      logger.error({ err }, 'Dynamic Drive sync failed');
      this.json(res, { error: err.message || 'Sync failed' }, 500);
    }
  }

  /**
   * Stream a video from Google Drive with range-header support for seeking.
   * Much more reliable than the Telegram iterDownload proxy.
   */
  private async serveDriveVideo(req: IncomingMessage, res: ServerResponse, fileId: string): Promise<void> {
    if (!this.driveUploader) {
      this.json(res, { error: 'Google Drive not configured' }, 503);
      return;
    }

    try {
      // Get file size for Content-Range header construction
      const metadata = await this.driveUploader.getFileMetadata(fileId);
      const fileSize = metadata.size;

      if (fileSize === 0) {
        this.json(res, { error: 'Invalid file' }, 404);
        return;
      }

      const range = req.headers.range;

      // Handle client disconnects
      let isAborted = false;
      req.on('close', () => { isAborted = true; });

      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0]!, 10);
        const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
        const chunkSize = end - start + 1;

        const { stream } = await this.driveUploader.streamFile(fileId, range);

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'video/mp4',
        });

        const readable = stream as NodeJS.ReadableStream;
        readable.on('data', (chunk: Buffer) => {
          if (!isAborted) res.write(chunk);
        });
        readable.on('end', () => {
          if (!isAborted) res.end();
        });
        readable.on('error', (err: Error) => {
          logger.error({ err, fileId }, 'Drive stream error');
          if (!isAborted && !res.writableEnded) res.end();
        });
      } else {
        const { stream } = await this.driveUploader.streamFile(fileId);

        res.writeHead(200, {
          'Content-Length': fileSize,
          'Content-Type': 'video/mp4',
          'Accept-Ranges': 'bytes',
        });

        const readable = stream as NodeJS.ReadableStream;
        readable.on('data', (chunk: Buffer) => {
          if (!isAborted) res.write(chunk);
        });
        readable.on('end', () => {
          if (!isAborted) res.end();
        });
        readable.on('error', (err: Error) => {
          logger.error({ err, fileId }, 'Drive stream error');
          if (!isAborted && !res.writableEnded) res.end();
        });
      }
    } catch (err: any) {
      logger.error({ err, fileId }, 'Failed to stream video from Google Drive');
      if (!res.headersSent) {
        this.json(res, { error: 'Streaming failed' }, 500);
      } else {
        res.end();
      }
    }
  }
}
