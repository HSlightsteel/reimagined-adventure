import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { TikTokAPI } from '../client/TikTokAPI';
import { HttpClient } from '../client/HttpClient';
import { StreamRecorder } from './StreamRecorder';
import { FollowersTracker } from './FollowersTracker';
import { Mode } from '../enums';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { convertFlvToMp4, concatFlvToMp4 } from '../utils/ffmpeg';
import { UserNotLiveError } from '../errors/errors';

export interface RecorderEvents {
  onStart?: (meta: { user: string; roomId: string }) => void;
  onStop?: () => void;
  onError?: (error: Error) => void;
  onComplete?: (mp4Path: string, user: string) => void;
}

export interface TikTokRecorderOptions {
  user: string;
  roomId?: string;
  mode: Mode;
  outputDir: string;
  intervalMinutes?: number;
  uploadAfterRecording?: boolean;
  maxParallelRecordings?: number;
  events?: RecorderEvents;
  initialChunks?: string[];
}

export class TikTokRecorder {
  private readonly abortController = new AbortController();
  private readonly api: TikTokAPI;
  private readonly streamRecorder: StreamRecorder;
  private readonly options: TikTokRecorderOptions;
  private chunkPaths: string[] = [];

  public prependChunks(paths: string[]): void {
    this.chunkPaths.unshift(...paths);
    logger.info({ user: this.options.user, chunksAdded: paths.length, totalChunks: this.chunkPaths.length }, 'Prepended orphaned chunks to active recorder');
  }

  constructor(options: TikTokRecorderOptions) {
    this.options = {
      intervalMinutes: 5,
      maxParallelRecordings: 3,
      ...options,
    };

    const http = new HttpClient({
      proxy: env.tiktok.proxy,
      cookies: {
        sessionid_ss: env.tiktok.sessionId,
        'tt-target-idc': env.tiktok.idc,
      },
    });

    this.api = new TikTokAPI(http);
    this.streamRecorder = new StreamRecorder(http);

    // Ensure output directory exists
    mkdir(this.options.outputDir, { recursive: true }).catch((err) => {
      logger.error({ err, dir: this.options.outputDir }, 'Failed to create output directory');
    });
  }

  async start(): Promise<void> {
    logger.info({ mode: this.options.mode, user: this.options.user }, 'Starting TikTok recorder');

    try {
      switch (this.options.mode) {
        case Mode.MANUAL:
          await this.runManual();
          break;

        case Mode.AUTOMATIC:
          await this.runAutomatic();
          break;

        case Mode.FOLLOWERS:
          await this.runFollowers();
          break;

        default:
          throw new Error(`Unknown mode: ${this.options.mode}`);
      }
    } catch (err) {
      this.options.events?.onError?.(err as Error);
      throw err;
    } finally {
      await this.cleanup();
    }
  }

  stop(): void {
    if (!this.abortController.signal.aborted) {
      logger.info('Stopping recorder');
      this.abortController.abort();
      this.options.events?.onStop?.();
    }
  }

  private async runManual(): Promise<void> {
    const roomId = this.options.roomId || await this.api.getRoomIdFromUser(this.options.user);
    
    const isLive = await this.api.isRoomAlive(roomId);
    if (!isLive) {
      throw new UserNotLiveError(`@${this.options.user} is not currently live`);
    }

    await this.record(roomId, this.options.user);
  }

  private async runAutomatic(): Promise<void> {
    const interval = (this.options.intervalMinutes || 5) * 60_000;

    logger.info({ intervalMinutes: this.options.intervalMinutes }, 'Starting automatic mode');

    while (!this.abortController.signal.aborted) {
      try {
        const roomId = this.options.roomId || await this.api.getRoomIdFromUser(this.options.user);
        
        if (await this.api.isRoomAlive(roomId)) {
          await this.record(roomId, this.options.user);
        } else {
          logger.debug({ user: this.options.user }, 'User is not live');
        }
      } catch (err) {
        logger.warn({ err }, 'Automatic loop error, will retry');
      }

      if (!this.abortController.signal.aborted) {
        logger.debug({ intervalMs: interval }, 'Waiting before next check');
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }
  }

  private async runFollowers(): Promise<void> {
    const tracker = new FollowersTracker();
    const maxParallel = this.options.maxParallelRecordings || 3;
    const interval = (this.options.intervalMinutes || 5) * 60_000;

    logger.info({ maxParallel, intervalMinutes: this.options.intervalMinutes }, 'Starting followers mode');

    const secUid = await this.api.getSecUid();
    if (!secUid) {
      throw new Error('Failed to resolve secUid for followers mode. Ensure you are logged in with valid cookies.');
    }

    // Setup cleanup on abort
    this.abortController.signal.addEventListener('abort', () => {
      tracker.stopAll().catch((err) => {
        logger.error({ err }, 'Error stopping all recordings');
      });
    });

    while (!this.abortController.signal.aborted) {
      try {
        const followers = await this.api.getFollowers(secUid);

        for (const follower of followers) {
          if (this.abortController.signal.aborted) {
            break;
          }

          if (tracker.has(follower)) {
            continue;
          }

          if (tracker.size() >= maxParallel) {
            logger.debug({ maxParallel }, 'Max parallel recordings reached');
            break;
          }

          const task = this.tryRecordFollower(follower);
          tracker.add(follower, task);

          // Rate limiting
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      } catch (err) {
        logger.warn({ err }, 'Followers polling error');
      }

      if (!this.abortController.signal.aborted) {
        logger.debug({ intervalMs: interval }, 'Waiting before next followers check');
        await new Promise((resolve) => setTimeout(resolve, interval));
      }
    }

    await tracker.stopAll();
  }

  private async tryRecordFollower(user: string): Promise<void> {
    try {
      logger.debug({ user }, 'Checking if follower is live');

      const roomId = await this.api.getRoomIdFromUser(user);
      
      const isLive = await this.api.isRoomAlive(roomId);
      if (!isLive) {
        return;
      }

      logger.info({ user, roomId }, 'Follower is live, starting recording');
      await this.record(roomId, user);
    } catch (err) {
      logger.warn({ user, err }, 'Follower recording failed');
    }
  }

  private async record(roomId: string, user: string): Promise<void> {
    const signal = this.abortController.signal;

    logger.info({ user, roomId }, 'Starting recording');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('_').split('.')[0];
    const mp4Path = join(this.options.outputDir, `TK_${user}_${timestamp}.mp4`);
    this.chunkPaths = [...(this.options.initialChunks || [])];
    let chunkIndex = this.chunkPaths.length;

    this.options.events?.onStart?.({ user, roomId });

    while (!signal.aborted) {
      try {
        const liveUrl = await this.api.getLiveStreamUrl(roomId);
        chunkIndex++;
        const flvPath = join(this.options.outputDir, `TK_${user}_${timestamp}_part${chunkIndex}.flv`);
        this.chunkPaths.push(flvPath);

        // Record stream (blocks until stream drops or abort)
        await this.streamRecorder.record(liveUrl, flvPath, { signal });
      } catch (err) {
        if (signal.aborted) {
          logger.info({ user }, 'Recording aborted by user/system');
          break;
        }
        logger.warn({ user, err }, 'Stream disconnected unexpectedly, preparing to check status');
      }

      if (signal.aborted) break;

      // The stream stopped (naturally or error). Check if they are still live (up to 12 times, 15s apart = 3 minutes).
      logger.info({ user }, 'Stream ended. Verifying if user is still live (auto-resume)...');
      
      let isLive = false;
      for (let attempt = 1; attempt <= 12; attempt++) {
        if (signal.aborted) break;
        await new Promise(resolve => setTimeout(resolve, 15000));
        logger.debug({ user, attempt }, 'Checking live status...');
        
        try {
          isLive = await this.api.isRoomAlive(roomId);
          if (isLive) break; // They are back online!
        } catch(err) {
          // ignore error and retry
        }
      }

      if (!isLive || signal.aborted) {
        logger.info({ user }, 'User is permanently offline or recording aborted. Finishing recording.');
        break;
      }
      
      logger.info({ user }, 'User is still live! Resuming recording into new chunk.');
    }

    if (this.chunkPaths.length === 0) {
      logger.warn({ user }, 'No data was recorded.');
      return;
    }

    try {
      if (this.chunkPaths.length === 1) {
        // Only one chunk, just convert it normally
        // NOTE: Do NOT pass abort signal here — we always want conversion to finish
        await convertFlvToMp4(this.chunkPaths[0]!, mp4Path);
      } else {
        // Multiple chunks, stitch them together
        await concatFlvToMp4(this.chunkPaths, mp4Path);
      }

      logger.info({ user, output: mp4Path }, 'Recording completed and processed successfully');

      // Notify the caller (BotController) that the recording is ready for upload
      if (this.options.uploadAfterRecording && this.options.events?.onComplete) {
        this.options.events.onComplete(mp4Path, user);
      }
    } catch (err) {
      logger.error({ err, user }, 'Failed to process recorded chunks');
    }
  }

  private async cleanup(): Promise<void> {
    logger.info('Cleaning up resources');
  }
}