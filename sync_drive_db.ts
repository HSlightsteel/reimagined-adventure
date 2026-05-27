import { GoogleDriveUploader } from './src/upload/GoogleDriveUploader';
import { RecordingsDB } from './src/db/RecordingsDB';
import { logger } from './src/utils/logger';

async function sync() {
  const uploader = new GoogleDriveUploader();
  const db = new RecordingsDB(process.env.OUTPUT_DIR || '/app/recordings');
  const drive = uploader['getDriveClient']();

  try {
    const username = 'highland.fashion7';
    const folderId = await uploader['getOrCreateUserFolder'](username);
    
    logger.info(`Fetching files for ${username} from Drive folder ${folderId}`);
    
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, size, createdTime)',
      pageSize: 1000
    });

    const files = response.data.files || [];
    logger.info(`Found ${files.length} files in Google Drive`);

    const records = await db.getAll();
    let updated = 0;
    let added = 0;

    for (const file of files) {
      if (!file.name?.endsWith('.mp4')) continue;

      const existing = records.find(r => r.filename === file.name);
      
      if (existing) {
        if (!existing.driveFileId) {
          logger.info(`Updating missing driveFileId for ${file.name}`);
          db.update(file.name, { driveFileId: file.id });
          updated++;
        }
      } else {
        logger.info(`Adding missing database entry for ${file.name}`);
        const sizeMB = Math.round(Number(file.size || 0) / (1024 * 1024));
        db.add({
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

    logger.info(`Sync complete. Added: ${added}, Updated: ${updated}`);
  } catch (err) {
    logger.error({ err }, 'Sync failed');
  } finally {
    await uploader.disconnect();
  }
}

sync();
