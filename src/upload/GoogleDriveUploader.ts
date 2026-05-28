import { google, drive_v3 } from 'googleapis';
import { createReadStream, existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { basename, join } from 'node:path';
import { logger } from '../utils/logger';
import { env } from '../config/env';

export class GoogleDriveUploader {
  private drive: drive_v3.Drive | null = null;
  private folderCache = new Map<string, string>();
  private readonly outputDir = process.env.OUTPUT_DIR || '/app/recordings';
  private readonly foldersFile = join(this.outputDir, 'drive_folders.json');

  constructor() {
    this.loadFolderCache();
  }

  private async loadFolderCache(): Promise<void> {
    try {
      const data = await fs.readFile(this.foldersFile, 'utf-8');
      const parsed = JSON.parse(data);
      for (const [k, v] of Object.entries(parsed)) {
        this.folderCache.set(k, String(v));
      }
    } catch {
      // Ignore if file doesn't exist
    }
  }

  private async saveFolderCache(): Promise<void> {
    try {
      const obj = Object.fromEntries(this.folderCache);
      await fs.writeFile(this.foldersFile, JSON.stringify(obj, null, 2), 'utf-8');
    } catch (err) {
      logger.error({ err }, 'Failed to save Drive folder cache');
    }
  }

  /**
   * Get or initialize the Google Drive API client using OAuth2 credentials.
   * Files are owned by the user's personal account (uses their storage quota).
   */
  public getDriveClient(): drive_v3.Drive {
    if (this.drive) return this.drive;

    if (!env.gdrive.clientId || !env.gdrive.clientSecret || !env.gdrive.refreshToken || !env.gdrive.folderId) {
      throw new Error('GDRIVE_CLIENT_ID, GDRIVE_CLIENT_SECRET, GDRIVE_REFRESH_TOKEN and GDRIVE_FOLDER_ID are required. Run: npx tsx gdrive_auth.ts');
    }

    const oauth2Client = new google.auth.OAuth2(
      env.gdrive.clientId,
      env.gdrive.clientSecret,
    );

    oauth2Client.setCredentials({
      refresh_token: env.gdrive.refreshToken,
    });

    this.drive = google.drive({ version: 'v3', auth: oauth2Client });
    logger.info('Google Drive client initialized (OAuth2)');
    return this.drive;
  }

  /**
   * Get or create a per-username subfolder within the root Drive folder.
   */
  public async getOrCreateUserFolder(username: string): Promise<string> {
    if (this.folderCache.has(username)) {
      return this.folderCache.get(username)!;
    }

    const drive = this.getDriveClient();

    // Search for existing folder
    try {
      const search = await drive.files.list({
        q: `name='${username}' and '${env.gdrive.folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id, name)',
        spaces: 'drive',
      });

      if (search.data.files && search.data.files.length > 0) {
        const folderId = search.data.files[0]!.id!;
        this.folderCache.set(username, folderId);
        await this.saveFolderCache();
        logger.info({ username, folderId }, 'Found existing Drive folder for user');
        return folderId;
      }
    } catch (err) {
      logger.warn({ err, username }, 'Error searching for existing Drive folder');
    }

    // Create new folder
    try {
      const folder = await drive.files.create({
        requestBody: {
          name: username,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [env.gdrive.folderId!],
        },
        fields: 'id',
      });

      const folderId = folder.data.id!;
      this.folderCache.set(username, folderId);
      await this.saveFolderCache();
      logger.info({ username, folderId }, 'Created new Drive folder for user');
      return folderId;
    } catch (err) {
      logger.error({ err, username }, 'Failed to create Drive folder');
      throw err;
    }
  }

  /**
   * Upload a video file to Google Drive in the user's subfolder.
   * Returns the Drive file ID.
   */
  public async upload(filePath: string, username: string): Promise<string> {
    const drive = this.getDriveClient();
    const filename = basename(filePath);
    const folderId = await this.getOrCreateUserFolder(username);

    const stat = await fs.stat(filePath);
    const sizeMB = Math.round(stat.size / (1024 * 1024));

    logger.info({ file: filename, sizeMB, username, folderId }, 'Uploading to Google Drive');

    try {
      const response = await drive.files.create({
        requestBody: {
          name: filename,
          parents: [folderId],
          mimeType: 'video/mp4',
        },
        media: {
          mimeType: 'video/mp4',
          body: createReadStream(filePath),
        },
        fields: 'id, name, size',
        uploadType: 'resumable',
      });

      const fileId = response.data.id!;
      logger.info({ file: filename, driveFileId: fileId, sizeMB }, 'Google Drive upload complete');
      return fileId;
    } catch (err) {
      logger.error({ err, file: filename }, 'Google Drive upload failed');
      throw err;
    }
  }

  /**
   * Upload a thumbnail image to Drive alongside the video.
   * Returns the Drive file ID of the thumbnail.
   */
  public async uploadThumbnail(thumbPath: string, username: string): Promise<string | undefined> {
    if (!existsSync(thumbPath)) return undefined;

    try {
      const drive = this.getDriveClient();
      const folderId = await this.getOrCreateUserFolder(username);
      const filename = basename(thumbPath);

      const response = await drive.files.create({
        requestBody: {
          name: filename,
          parents: [folderId],
          mimeType: 'image/jpeg',
        },
        media: {
          mimeType: 'image/jpeg',
          body: createReadStream(thumbPath),
        },
        fields: 'id',
      });

      return response.data.id || undefined;
    } catch (err) {
      logger.warn({ err }, 'Failed to upload thumbnail to Drive');
      return undefined;
    }
  }

  /**
   * Get metadata for a file (mainly for getting size for range requests).
   */
  public async getFileMetadata(fileId: string): Promise<{ size: number; name: string; mimeType: string }> {
    const drive = this.getDriveClient();
    const response = await drive.files.get({
      fileId,
      fields: 'size, name, mimeType',
    });

    return {
      size: parseInt(response.data.size || '0', 10),
      name: response.data.name || 'unknown',
      mimeType: response.data.mimeType || 'video/mp4',
    };
  }

  /**
   * Stream a file from Google Drive. Supports range headers for video seeking.
   * Returns the stream and relevant headers.
   */
  public async streamFile(fileId: string, rangeHeader?: string): Promise<{
    stream: NodeJS.ReadableStream;
    headers: Record<string, string | number>;
    status: number;
  }> {
    const drive = this.getDriveClient();

    const requestConfig: any = {
      responseType: 'stream',
    };

    if (rangeHeader) {
      requestConfig.headers = { Range: rangeHeader };
    }

    const response = await drive.files.get(
      { fileId, alt: 'media', acknowledgeAbuse: true },
      requestConfig,
    );

    const headers: Record<string, string | number> = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    };

    // Forward range-related headers from Drive's response
    const respHeaders = (response as any).headers || {};
    if (respHeaders['content-range']) {
      headers['Content-Range'] = respHeaders['content-range'];
    }
    if (respHeaders['content-length']) {
      headers['Content-Length'] = respHeaders['content-length'];
    }

    const status = rangeHeader ? 206 : 200;

    return {
      stream: response.data as unknown as NodeJS.ReadableStream,
      headers,
      status,
    };
  }

  /**
   * No persistent connection to clean up (unlike Telegram MTProto).
   */
  async disconnect(): Promise<void> {
    this.drive = null;
    logger.info('Google Drive client released');
  }
}
