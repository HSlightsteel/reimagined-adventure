/**
 * migrate_to_drive.ts
 * 
 * Migrates existing Telegram-hosted recordings to Google Drive.
 * For each recording in recordings.json that has a messageId but no driveFileId:
 *   1. Downloads the video from Telegram
 *   2. Uploads it to Google Drive (in a per-username folder)
 *   3. Updates recordings.json with the new driveFileId
 * 
 * Usage: npx tsx migrate_to_drive.ts
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { google } from 'googleapis';
import { join } from 'node:path';
import { existsSync, promises as fs, createReadStream, createWriteStream } from 'node:fs';
import dotenv from 'dotenv';
dotenv.config();

const outputDir = process.env.OUTPUT_DIR || '/app/recordings';
const dbPath = join(outputDir, 'recordings.json');
const tempDir = join(outputDir, '.migrate_temp');

interface RecordingEntry {
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

function initDriveClient() {
    if (!process.env.GDRIVE_KEY_FILE || !process.env.GDRIVE_FOLDER_ID) {
        throw new Error('GDRIVE_KEY_FILE and GDRIVE_FOLDER_ID are required for migration');
    }

    const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GDRIVE_KEY_FILE,
        scopes: ['https://www.googleapis.com/auth/drive'],
    });

    return google.drive({ version: 'v3', auth });
}

const folderCache = new Map<string, string>();

async function getOrCreateDriveFolder(drive: any, username: string): Promise<string> {
    if (folderCache.has(username)) return folderCache.get(username)!;

    const parentId = process.env.GDRIVE_FOLDER_ID!;

    const search = await drive.files.list({
        q: `name='${username}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
        spaces: 'drive',
    });

    if (search.data.files && search.data.files.length > 0) {
        const id = search.data.files[0].id;
        folderCache.set(username, id);
        return id;
    }

    const folder = await drive.files.create({
        requestBody: {
            name: username,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
        },
        fields: 'id',
    });

    const id = folder.data.id;
    folderCache.set(username, id);
    return id;
}

async function downloadFromTelegram(client: TelegramClient, messageId: number, savePath: string): Promise<void> {
    const bigInt = require('big-integer');
    const msgs = await client.getMessages(Number(process.env.TELEGRAM_CHAT_ID), { ids: messageId });
    const msg = msgs[0];
    if (!msg || !msg.media) {
        throw new Error(`Message ${messageId} has no media`);
    }

    const writeStream = createWriteStream(savePath);

    const stream = client.iterDownload({
        file: msg.media,
        offset: bigInt(0),
        requestSize: 1048576, // 1MB chunks
    });

    let downloaded = 0;
    for await (const chunk of stream) {
        writeStream.write(chunk);
        downloaded += chunk.length;
        process.stdout.write(`\r  Downloaded: ${Math.round(downloaded / 1024 / 1024)} MB`);
    }
    
    writeStream.end();
    await new Promise<void>((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });
    
    console.log('');
}

async function uploadToDrive(drive: any, filePath: string, username: string, filename: string): Promise<string> {
    const folderId = await getOrCreateDriveFolder(drive, username);

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
        fields: 'id',
    });

    return response.data.id;
}

async function run() {
    console.log('=== Telegram → Google Drive Migration ===\n');

    // Load recordings
    if (!existsSync(dbPath)) {
        console.log('No recordings.json found. Nothing to migrate.');
        return;
    }

    const data = await fs.readFile(dbPath, 'utf-8');
    const recordings: RecordingEntry[] = JSON.parse(data);

    // Find recordings needing migration
    const needsMigration = recordings.filter(r => r.messageId && !r.driveFileId);
    
    if (needsMigration.length === 0) {
        console.log('All recordings already have driveFileId. Nothing to migrate!');
        return;
    }

    console.log(`Found ${needsMigration.length} recordings to migrate.\n`);

    // Init clients
    const session = new StringSession('');
    const client = new TelegramClient(session, Number(process.env.TELEGRAM_API_ID), process.env.TELEGRAM_API_HASH!, { connectionRetries: 5 });
    await client.start({ botAuthToken: process.env.TELEGRAM_BOT_TOKEN! });
    console.log('Telegram client connected.');

    const drive = initDriveClient();
    console.log('Google Drive client initialized.\n');

    // Create temp dir
    await fs.mkdir(tempDir, { recursive: true });

    let migrated = 0;
    let failed = 0;

    for (const rec of needsMigration) {
        console.log(`[${migrated + failed + 1}/${needsMigration.length}] ${rec.filename} (${rec.username})`);

        const tempFile = join(tempDir, rec.filename);

        try {
            // Step 1: Download from Telegram
            console.log(`  Downloading from Telegram (msg ${rec.messageId})...`);
            await downloadFromTelegram(client, rec.messageId!, tempFile);

            // Step 2: Upload to Google Drive
            console.log(`  Uploading to Google Drive...`);
            const driveFileId = await uploadToDrive(drive, tempFile, rec.username, rec.filename);
            console.log(`  ✅ Drive file ID: ${driveFileId}`);

            // Step 3: Update the recording entry
            const idx = recordings.findIndex(r => r.filename === rec.filename);
            if (idx !== -1) {
                recordings[idx].driveFileId = driveFileId;
            }

            // Save after each successful migration (in case of crash)
            await fs.writeFile(dbPath, JSON.stringify(recordings, null, 2));

            // Clean up temp file
            try { await fs.unlink(tempFile); } catch {}

            migrated++;
        } catch (err: any) {
            console.error(`  ❌ Failed: ${err.message}`);
            // Clean up temp file on failure too
            try { await fs.unlink(tempFile); } catch {}
            failed++;
        }

        console.log('');
    }

    // Clean up temp dir
    try { await fs.rmdir(tempDir); } catch {}

    await client.disconnect();

    console.log('=== Migration Complete ===');
    console.log(`  ✅ Migrated: ${migrated}`);
    console.log(`  ❌ Failed: ${failed}`);
    console.log(`  Total: ${needsMigration.length}`);
}

run().catch(console.error);
