import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { join } from 'node:path';
import { existsSync, promises as fs } from 'node:fs';
import dotenv from 'dotenv';
dotenv.config();

const messageIds = [240, 229, 236];

async function generateThumbnailFromTelegram(client: TelegramClient, messageId: number, filename: string): Promise<string> {
    return '';
}

function parseDurationToSeconds(durStr: string): number {
    let s = 0;
    const hMatch = durStr.match(/(\d+)h/);
    const mMatch = durStr.match(/(\d+)m/);
    const sMatch = durStr.match(/(\d+)s/);
    if (hMatch) s += parseInt(hMatch[1]!) * 3600;
    if (mMatch) s += parseInt(mMatch[1]!) * 60;
    if (sMatch) s += parseInt(sMatch[1]!);
    return s;
}

function parseSizeToMB(sizeStr: string): number {
    const num = parseFloat(sizeStr);
    if (sizeStr.includes('GB')) return Math.round(num * 1024);
    return Math.round(num);
}

async function run() {
    const session = new StringSession('');
    const client = new TelegramClient(session, Number(process.env.TELEGRAM_API_ID), process.env.TELEGRAM_API_HASH!, { connectionRetries: 5 });
    await client.start({ botAuthToken: process.env.TELEGRAM_BOT_TOKEN! });
    
    const outputDir = process.env.OUTPUT_DIR || '/app/recordings';
    const dbPath = join(outputDir, 'recordings.json');

    for (const msgId of messageIds) {
        console.log(`Fetching message ${msgId}...`);
        const msgs = await client.getMessages(Number(process.env.TELEGRAM_CHAT_ID), { ids: msgId });
        const msg = msgs[0];
        if (!msg) {
            console.log(`Message ${msgId} not found.`);
            continue;
        }

        const text = msg.message;
        if (!text) {
            console.log(`Message ${msgId} has no text.`);
            continue;
        }

        console.log(`Text: ${text}`);

        // Parse:
        // 🎬 username - Part X/Y
        // ⏱ 1h 20m 5s · 💾 1.2 GB
        const lines = text.split('\n');
        const titleLine = lines[0] || '';
        const metaLine = lines[1] || '';

        const usernameMatch = titleLine.match(/🎬 ([A-Za-z0-9_.-]+)/);
        const username = usernameMatch ? usernameMatch[1] : 'unknown';

        const isPart = titleLine.includes('Part');
        let partIndex, totalParts;
        if (isPart) {
            const pMatch = titleLine.match(/Part (\d+)\/(\d+)/);
            if (pMatch) {
                partIndex = parseInt(pMatch[1]!);
                totalParts = parseInt(pMatch[2]!);
            }
        }

        const durMatch = metaLine.match(/⏱ ([^·]+)·/);
        const sizeMatch = metaLine.match(/💾 (.+)/);

        const durStr = durMatch ? durMatch[1]!.trim() : '0s';
        const sizeStr = sizeMatch ? sizeMatch[1]!.trim() : '0 MB';

        const duration = parseDurationToSeconds(durStr);
        const sizeMB = parseSizeToMB(sizeStr);

        // Fake a filename for the DB so the player works
        const timestamp = new Date((msg.date || Math.floor(Date.now()/1000)) * 1000);
        const tsStr = timestamp.toISOString().replace(/[:.]/g, '-').split('T').join('_').split('.')[0];
        const filename = `TK_${username}_${tsStr}${isPart ? `_split00${partIndex}` : ''}.mp4`;

        console.log(`Parsed: User=${username}, File=${filename}, Dur=${duration}s, Size=${sizeMB}MB`);

        const thumb = await generateThumbnailFromTelegram(client, msgId, filename.replace('.mp4', ''));

        let all = [];
        try {
            const data = await fs.readFile(dbPath, 'utf-8');
            all = JSON.parse(data);
        } catch {}

        all.push({
            filename,
            username: username as string,
            sizeMB,
            duration,
            date: timestamp.toISOString(),
            thumb,
            messageId: msgId,
            isPart,
            partIndex,
            totalParts
        });
        
        await fs.writeFile(dbPath, JSON.stringify(all, null, 2), 'utf-8');
        console.log(`Added message ${msgId} to recordings.json`);
    }

    await client.disconnect();
    console.log('Done!');
}

run().catch(console.error);
