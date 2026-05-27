/**
 * upload_all_now.ts
 * 
 * Uploads ALL local .mp4 recordings to both Telegram (sendVideo) and Google Drive.
 * - Creates per-username folders on Drive (like Telegram topics)
 * - Creates per-username forum topics on Telegram  
 * - Skips files already in recordings.json that have BOTH messageId and driveFileId
 * - For files in DB with messageId but no driveFileId, uploads only to Drive
 * - For files not in DB at all, uploads to both
 * 
 * Usage: npx tsx upload_all_now.ts
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { google } from 'googleapis';
import { join, basename } from 'node:path';
import { existsSync, promises as fs, createReadStream, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
dotenv.config();

const outputDir = process.env.OUTPUT_DIR || './recordings';
const dbPath = join(outputDir, 'recordings.json');
const topicsPath = join(outputDir, 'topics.json');

// ── Helpers ──

async function getDurationSeconds(filePath: string): Promise<number> {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath
    ]);
    let out = '';
    ffprobe.stdout.on('data', (d: Buffer) => out += d.toString());
    ffprobe.on('close', () => resolve(Math.round(parseFloat(out.trim()) || 0)));
    ffprobe.on('error', () => resolve(0));
  });
}

function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

function extractUsername(filename: string): string | null {
  const match = filename.match(/^TK_(.+?)_\d{4}-\d{2}-\d{2}/);
  return match ? match[1] : null;
}

// ── Telegram ──

async function initTelegram(): Promise<TelegramClient> {
  const session = new StringSession('');
  const client = new TelegramClient(
    session,
    Number(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH!,
    { connectionRetries: 5 }
  );
  await client.start({ botAuthToken: process.env.TELEGRAM_BOT_TOKEN! });
  console.log('✅ Telegram client connected');
  return client;
}

const topicCache = new Map<string, number>();

async function loadTopics(): Promise<void> {
  try {
    const data = await fs.readFile(topicsPath, 'utf-8');
    const parsed = JSON.parse(data);
    for (const [k, v] of Object.entries(parsed)) {
      topicCache.set(k, Number(v));
    }
  } catch {}
}

async function saveTopics(): Promise<void> {
  const obj = Object.fromEntries(topicCache);
  await fs.writeFile(topicsPath, JSON.stringify(obj, null, 2), 'utf-8');
}

async function getOrCreateTopic(username: string): Promise<number | undefined> {
  if (topicCache.has(username)) return topicCache.get(username);

  try {
    const response = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/createForumTopic`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.TELEGRAM_CHAT_ID,
          name: username,
        }),
      }
    );
    const data = await response.json() as any;
    if (data.ok) {
      const threadId = data.result.message_thread_id;
      topicCache.set(username, threadId);
      await saveTopics();
      console.log(`  📁 Created Telegram topic for ${username} (thread ${threadId})`);
      return threadId;
    }
  } catch (err: any) {
    console.warn(`  ⚠️ Failed to create topic: ${err.message}`);
  }
  return undefined;
}

async function uploadToTelegram(
  client: TelegramClient,
  filePath: string,
  username: string,
  durationStr: string,
  sizeStr: string,
  totalBytes: number
): Promise<number | undefined> {
  const threadId = await getOrCreateTopic(username);
  const caption = `🎬 <b>${username}</b>\n⏱ ${durationStr} · 💾 ${sizeStr}\nRecorded by @tiikstreambot`;

  let lastPct = 0;
  try {
    const msg = await client.sendFile(Number(process.env.TELEGRAM_CHAT_ID), {
      file: filePath,
      caption,
      parseMode: 'html',
      forceDocument: false,
      supportsStreaming: true,
      replyTo: threadId,
      progressCallback: (sent: number) => {
        const pct = Math.round((Number(sent) / totalBytes) * 100);
        if (pct >= lastPct + 5) {
          lastPct = pct;
          process.stdout.write(`\r  📡 Telegram: ${pct}% (${Math.round(Number(sent) / 1024 / 1024)} / ${Math.round(totalBytes / 1024 / 1024)} MB)`);
        }
      },
    });
    process.stdout.write('\n');
    return msg.id;
  } catch (err: any) {
    process.stdout.write('\n');
    console.error(`  ❌ Telegram upload failed: ${err.message}`);
    return undefined;
  }
}

// ── Google Drive ──

function initDrive() {
  if (!process.env.GDRIVE_CLIENT_ID || !process.env.GDRIVE_CLIENT_SECRET || !process.env.GDRIVE_REFRESH_TOKEN || !process.env.GDRIVE_FOLDER_ID) {
    console.log('⚠️ Google Drive OAuth2 not configured. Run: npx tsx gdrive_auth.ts');
    return null;
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GDRIVE_CLIENT_ID,
    process.env.GDRIVE_CLIENT_SECRET,
  );

  oauth2Client.setCredentials({
    refresh_token: process.env.GDRIVE_REFRESH_TOKEN,
  });

  const drive = google.drive({ version: 'v3', auth: oauth2Client });
  console.log('✅ Google Drive client initialized (OAuth2 — files owned by your account)');
  return drive;
}

const driveFolderCache = new Map<string, string>();

async function getOrCreateDriveFolder(drive: any, username: string): Promise<string> {
  if (driveFolderCache.has(username)) return driveFolderCache.get(username)!;

  const parentId = process.env.GDRIVE_FOLDER_ID!;

  // Search existing
  const search = await drive.files.list({
    q: `name='${username}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  if (search.data.files?.length > 0) {
    const id = search.data.files[0].id;
    driveFolderCache.set(username, id);
    return id;
  }

  // Create
  const folder = await drive.files.create({
    requestBody: {
      name: username,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });

  const id = folder.data.id;
  driveFolderCache.set(username, id);
  console.log(`  📁 Created Drive folder for ${username}`);
  return id;
}

async function uploadToDrive(drive: any, filePath: string, username: string, totalBytes: number): Promise<string | undefined> {
  try {
    const folderId = await getOrCreateDriveFolder(drive, username);
    const filename = basename(filePath);

    // Create a stream with progress tracking
    const fileStream = createReadStream(filePath);
    let uploaded = 0;
    let lastPct = 0;
    fileStream.on('data', (chunk: Buffer) => {
      uploaded += chunk.length;
      const pct = Math.round((uploaded / totalBytes) * 100);
      if (pct >= lastPct + 5) {
        lastPct = pct;
        process.stdout.write(`\r  ☁️ Drive: ${pct}% (${Math.round(uploaded / 1024 / 1024)} / ${Math.round(totalBytes / 1024 / 1024)} MB)`);
      }
    });

    const response = await drive.files.create({
      requestBody: {
        name: filename,
        parents: [folderId],
        mimeType: 'video/mp4',
      },
      media: {
        mimeType: 'video/mp4',
        body: fileStream,
      },
      fields: 'id',
    });

    process.stdout.write('\n');
    return response.data.id;
  } catch (err: any) {
    process.stdout.write('\n');
    console.error(`  ❌ Drive upload failed: ${err.message}`);
    return undefined;
  }
}

// ── Main ──

async function run() {
  console.log('═══════════════════════════════════════════════');
  console.log('  Bulk Upload: All Recordings → Telegram + Drive');
  console.log('═══════════════════════════════════════════════\n');

  // Load DB
  let recordings: any[] = [];
  if (existsSync(dbPath)) {
    try { recordings = JSON.parse(await fs.readFile(dbPath, 'utf-8')); } catch {}
  }

  await loadTopics();

  // Find all MP4 files, sorted smallest-first for faster initial feedback
  const allFiles = await fs.readdir(outputDir);
  const mp4Files = allFiles
    .filter(f => f.endsWith('.mp4') && f.startsWith('TK_'))
    .sort((a, b) => statSync(join(outputDir, a)).size - statSync(join(outputDir, b)).size);

  console.log(`Found ${mp4Files.length} MP4 files in ${outputDir}\n`);

  // Init clients
  const client = await initTelegram();
  const drive = initDrive();
  console.log('');

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < mp4Files.length; i++) {
    const filename = mp4Files[i];
    const filePath = join(outputDir, filename);
    const username = extractUsername(filename);

    if (!username) {
      console.log(`[${i + 1}/${mp4Files.length}] ⏭ Skipping ${filename} (can't parse username)`);
      skipped++;
      continue;
    }

    // Check existing DB entry
    const existing = recordings.find(r => r.filename === filename);
    const hasMessage = existing?.messageId;
    const hasDrive = existing?.driveFileId;

    if (hasMessage && hasDrive) {
      console.log(`[${i + 1}/${mp4Files.length}] ⏭ ${filename} — already uploaded to both`);
      skipped++;
      continue;
    }

    const stat = statSync(filePath);
    const sizeMB = Math.round(stat.size / (1024 * 1024));
    const sizeStr = formatSize(stat.size);
    const durSec = await getDurationSeconds(filePath);
    const durStr = formatDuration(durSec);

    console.log(`[${i + 1}/${mp4Files.length}] 📤 ${filename}`);
    console.log(`  👤 ${username} | ⏱ ${durStr} | 💾 ${sizeStr}`);

    let msgId = hasMessage ? existing.messageId : undefined;
    let driveFileId = hasDrive ? existing.driveFileId : undefined;

    // Upload to Drive FIRST (faster, more reliable, gives quicker feedback)
    if (!driveFileId && drive) {
      console.log(`  → Uploading to Google Drive...`);
      driveFileId = await uploadToDrive(drive, filePath, username, stat.size);
      if (driveFileId) console.log(`  ✅ Drive: ${driveFileId}`);
    } else if (driveFileId) {
      console.log(`  → Drive: already uploaded (${driveFileId})`);
    }

    // Upload to Telegram
    if (!msgId) {
      console.log(`  → Uploading to Telegram (sendVideo)...`);
      msgId = await uploadToTelegram(client, filePath, username, durStr, sizeStr, stat.size);
      if (msgId) console.log(`  ✅ Telegram: message ${msgId}`);
    } else {
      console.log(`  → Telegram: already uploaded (msg ${msgId})`);
    }

    // Update or create DB entry
    if (msgId || driveFileId) {
      if (existing) {
        // Update existing entry
        const idx = recordings.indexOf(existing);
        recordings[idx] = { ...existing, messageId: msgId || existing.messageId, driveFileId };
      } else {
        // New entry
        recordings.push({
          filename,
          username,
          sizeMB,
          duration: durSec,
          date: new Date().toISOString(),
          thumb: '',
          messageId: msgId,
          driveFileId,
          isPart: false,
        });
      }

      await fs.writeFile(dbPath, JSON.stringify(recordings, null, 2));
      uploaded++;
    } else {
      failed++;
    }

    console.log('');
  }

  await client.disconnect();

  console.log('═══════════════════════════════════════════════');
  console.log(`  ✅ Uploaded: ${uploaded}`);
  console.log(`  ⏭ Skipped:  ${skipped}`);
  console.log(`  ❌ Failed:   ${failed}`);
  console.log(`  Total:      ${mp4Files.length}`);
  console.log('═══════════════════════════════════════════════');
}

run().catch(console.error);
