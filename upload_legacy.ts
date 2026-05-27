import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { CustomFile } from 'telegram/client/uploads.js';
import { google } from 'googleapis';
import { join } from 'node:path';
import { existsSync, promises as fs, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import dotenv from 'dotenv';
dotenv.config();

const outputDir = process.env.OUTPUT_DIR || '/app/recordings';
const dbPath = join(outputDir, 'recordings.json');

async function getDuration(filePath: string): Promise<number> {
    return new Promise((resolve) => {
        const ffprobe = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ]);
        let out = '';
        ffprobe.stdout.on('data', d => out += d);
        ffprobe.on('close', () => resolve(parseFloat(out) || 0));
    });
}

function parseDateFromFilename(filename: string): Date {
    // Expected: TK_username_2026-05-17_06-57-14-730Z.mp4
    const match = filename.match(/_(\\d{4}-\\d{2}-\\d{2}_\\d{2}-\\d{2}-\\d{2}-\\d{3}Z)/);
    if (!match) return new Date();
    
    const parts = match[1].split('_'); // ['2026-05-17', '06-57-14-730Z']
    const timeParts = parts[1].split('-'); // ['06', '57', '14', '730Z']
    const isoStr = `${parts[0]}T${timeParts[0]}:${timeParts[1]}:${timeParts[2]}.${timeParts[3]}`;
    return new Date(isoStr);
}

async function concatFiles(files: string[], outPath: string): Promise<void> {
    if (files.length === 1) {
        await fs.copyFile(files[0], outPath);
        return;
    }
    const listFile = outPath + '.txt';
    const listContent = files.map(f => `file '${f}'`).join('\\n');
    await fs.writeFile(listFile, listContent);
    
    return new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
            '-f', 'concat',
            '-safe', '0',
            '-i', listFile,
            '-c', 'copy',
            '-y',
            outPath
        ]);
        ffmpeg.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error('FFmpeg failed with code ' + code));
        });
    });
}

function formatDuration(s: number): string {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    let str = '';
    if (h > 0) str += `${h}h `;
    if (m > 0 || h > 0) str += `${m}m `;
    str += `${sec}s`;
    return str.trim();
}

function formatSize(bytes: number): string {
    if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(2) + ' GB';
    return (bytes / 1024 ** 2).toFixed(0) + ' MB';
}

function initDriveClient() {
    if (!process.env.GDRIVE_KEY_FILE || !process.env.GDRIVE_FOLDER_ID) {
        console.log('Google Drive not configured (GDRIVE_KEY_FILE / GDRIVE_FOLDER_ID), skipping Drive upload.');
        return null;
    }

    const auth = new google.auth.GoogleAuth({
        keyFile: process.env.GDRIVE_KEY_FILE,
        scopes: ['https://www.googleapis.com/auth/drive'],
    });

    return google.drive({ version: 'v3', auth });
}

async function getOrCreateDriveFolder(drive: any, username: string): Promise<string> {
    const parentId = process.env.GDRIVE_FOLDER_ID!;

    // Search for existing folder
    const search = await drive.files.list({
        q: `name='${username}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
        spaces: 'drive',
    });

    if (search.data.files && search.data.files.length > 0) {
        return search.data.files[0].id;
    }

    // Create new folder
    const folder = await drive.files.create({
        requestBody: {
            name: username,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [parentId],
        },
        fields: 'id',
    });

    return folder.data.id;
}

async function uploadToDrive(drive: any, filePath: string, username: string): Promise<string> {
    const folderId = await getOrCreateDriveFolder(drive, username);
    const filename = filePath.split(/[\\/]/).pop() || '';

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
    console.log('Starting legacy upload script (dual: Telegram + Google Drive)...');
    const session = new StringSession('');
    const client = new TelegramClient(session, Number(process.env.TELEGRAM_API_ID), process.env.TELEGRAM_API_HASH!, { connectionRetries: 5 });
    await client.start({ botAuthToken: process.env.TELEGRAM_BOT_TOKEN! });
    
    const drive = initDriveClient();

    // Read recordings.json
    let existingRecs: any[] = [];
    if (existsSync(dbPath)) {
        const dbData = await fs.readFile(dbPath, 'utf-8');
        try { existingRecs = JSON.parse(dbData); } catch {}
    }

    const files = await fs.readdir(outputDir);
    const mediaFiles = files.filter(f => f.endsWith('.mp4') || f.endsWith('.flv'));

    interface FileMeta {
        name: string;
        path: string;
        username: string;
        startTime: number; // seconds epoch
        duration: number; // seconds
        endTime: number; // seconds epoch
    }

    const fileMetas: FileMeta[] = [];
    
    console.log('Parsing file metadata...');
    for (const f of mediaFiles) {
        if (f.includes('_part') || f.includes('merged')) continue;
        
        // Skip if this exact filename is already in the database
        if (existingRecs.some(r => r.filename === f)) {
            console.log(`Skipping ${f}, already in DB.`);
            continue;
        }

        const match = f.match(/^TK_([A-Za-z0-9_.-]+?)_\\d{4}-\\d{2}-\\d{2}_/);
        if (!match) continue;

        const username = match[1];
        const fullPath = join(outputDir, f);
        const startTime = parseDateFromFilename(f).getTime() / 1000;
        const dur = await getDuration(fullPath);
        
        fileMetas.push({
            name: f,
            path: fullPath,
            username,
            startTime,
            duration: dur,
            endTime: startTime + dur
        });
    }

    // Group by username
    const byUser: Record<string, FileMeta[]> = {};
    for (const fm of fileMetas) {
        if (!byUser[fm.username]) byUser[fm.username] = [];
        byUser[fm.username].push(fm);
    }

    for (const [username, userFiles] of Object.entries(byUser)) {
        // Sort chronologically
        userFiles.sort((a, b) => a.startTime - b.startTime);

        const groups: FileMeta[][] = [];
        let currentGroup: FileMeta[] = [userFiles[0]];

        for (let i = 1; i < userFiles.length; i++) {
            const f = userFiles[i];
            const prev = currentGroup[currentGroup.length - 1];
            
            // Check gap
            const gap = f.startTime - prev.endTime;
            if (gap <= 10 * 60) {
                // Gap is less than 10 mins, group them
                currentGroup.push(f);
            } else {
                groups.push(currentGroup);
                currentGroup = [f];
            }
        }
        groups.push(currentGroup);

        for (const group of groups) {
            console.log(`\\nGroup for ${username}: ${group.length} files`);
            group.forEach(f => console.log(`  - ${f.name} (dur: ${f.duration}s)`));

            // Merge
            const tsStr = new Date(group[0].startTime * 1000).toISOString().replace(/[:.]/g, '-').split('T').join('_').split('.')[0];
            const mergedName = `TK_${username}_${tsStr}_merged.mp4`;
            const mergedPath = join(outputDir, mergedName);

            console.log(`Merging into: ${mergedName}`);
            await concatFiles(group.map(f => f.path), mergedPath);

            const stat = await fs.stat(mergedPath);
            const size = stat.size;
            const mergedDur = await getDuration(mergedPath);

            // 1. Upload to Telegram
            let msgId: number | undefined;
            console.log(`Uploading ${mergedName} to Telegram (${formatSize(size)})...`);
            let caption = `🎬 ${username}\\n⏱ ${formatDuration(mergedDur)} · 💾 ${formatSize(size)}\\nRecorded by @tiikstreambot`;
            
            const media = new CustomFile(mergedName, stat.size, mergedPath);

            try {
                const message = await client.sendFile(Number(process.env.TELEGRAM_CHAT_ID), {
                    file: media,
                    caption,
                    forceDocument: false,
                    supportsStreaming: true,
                    workers: 4
                });
                msgId = message.id;
                console.log(`Telegram upload complete! Message ID: ${msgId}`);
            } catch (err: any) {
                console.error(`Telegram upload failed for ${mergedName}:`, err.message);
            }

            // 2. Upload to Google Drive
            let driveFileId: string | undefined;
            if (drive) {
                try {
                    console.log(`Uploading ${mergedName} to Google Drive...`);
                    driveFileId = await uploadToDrive(drive, mergedPath, username);
                    console.log(`Google Drive upload complete! File ID: ${driveFileId}`);
                } catch (err: any) {
                    console.error(`Google Drive upload failed for ${mergedName}:`, err.message);
                }
            }

            // 3. Save to DB
            if (msgId || driveFileId) {
                existingRecs.push({
                    filename: mergedName,
                    username,
                    sizeMB: Math.round(size / 1024 / 1024),
                    duration: Math.round(mergedDur),
                    date: new Date(group[0].startTime * 1000).toISOString(),
                    thumb: '',
                    messageId: msgId,
                    driveFileId,
                    isPart: false
                });
                
                await fs.writeFile(dbPath, JSON.stringify(existingRecs, null, 2));
                console.log(`Added ${mergedName} to recordings.json`);
            }
        }
    }

    await client.disconnect();
    console.log('Legacy upload complete!');
}

run().catch(console.error);
