import { GoogleDriveUploader } from './src/upload/GoogleDriveUploader';

async function list() {
  const uploader = new GoogleDriveUploader();
  const drive = uploader['getDriveClient']();
  const folderId = await uploader['getOrCreateUserFolder']('highland.fashion7');
  const res = await drive.files.list({ q: `'${folderId}' in parents and trashed = false` });
  console.log(JSON.stringify(res.data.files.map(f => f.name), null, 2));
}
list();
