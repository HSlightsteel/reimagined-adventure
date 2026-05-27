/**
 * gdrive_auth.ts
 * 
 * One-time script to generate a Google Drive OAuth2 refresh token.
 * Run this once, follow the URL, paste the code, and it will save
 * the refresh token to your .env file.
 * 
 * Prerequisites:
 *   1. Go to Google Cloud Console > APIs & Services > Credentials
 *   2. Create OAuth 2.0 Client ID (type: "Desktop app")
 *   3. Add GDRIVE_CLIENT_ID and GDRIVE_CLIENT_SECRET to your .env
 * 
 * Usage: npx tsx gdrive_auth.ts
 */

import { google } from 'googleapis';
import { createServer } from 'node:http';
import { promises as fs } from 'node:fs';
import dotenv from 'dotenv';
dotenv.config();

const CLIENT_ID = process.env.GDRIVE_CLIENT_ID;
const CLIENT_SECRET = process.env.GDRIVE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:9876';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ Missing GDRIVE_CLIENT_ID or GDRIVE_CLIENT_SECRET in .env');
  console.error('');
  console.error('Steps to get these:');
  console.error('  1. Go to https://console.cloud.google.com/apis/credentials');
  console.error('  2. Click "Create Credentials" → "OAuth client ID"');
  console.error('  3. Application type: "Desktop app"');
  console.error('  4. Copy the Client ID and Client Secret to your .env:');
  console.error('     GDRIVE_CLIENT_ID=your_client_id');
  console.error('     GDRIVE_CLIENT_SECRET=your_client_secret');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: ['https://www.googleapis.com/auth/drive'],
});

console.log('═══════════════════════════════════════════════════════');
console.log('  Google Drive OAuth2 Setup');
console.log('═══════════════════════════════════════════════════════\n');
console.log('Open this URL in your browser to authorize:\n');
console.log(`  ${authUrl}\n`);
console.log('Waiting for callback on http://localhost:9876 ...\n');

// Start a tiny HTTP server to catch the OAuth callback
const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:9876`);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400);
    res.end('Missing authorization code');
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);
    const refreshToken = tokens.refresh_token;

    if (!refreshToken) {
      res.writeHead(500);
      res.end('No refresh token received. Try revoking access at https://myaccount.google.com/permissions and run again.');
      return;
    }

    console.log('✅ Got refresh token!\n');

    // Append to .env
    const envPath = '.env';
    let envContent = '';
    try { envContent = await fs.readFile(envPath, 'utf-8'); } catch {}

    // Replace or add GDRIVE_REFRESH_TOKEN
    if (envContent.includes('GDRIVE_REFRESH_TOKEN=')) {
      envContent = envContent.replace(/GDRIVE_REFRESH_TOKEN=.*/g, `GDRIVE_REFRESH_TOKEN=${refreshToken}`);
    } else {
      envContent += `\nGDRIVE_REFRESH_TOKEN=${refreshToken}\n`;
    }

    await fs.writeFile(envPath, envContent);
    console.log('✅ Saved GDRIVE_REFRESH_TOKEN to .env\n');

    // Also remove the old key file ref if present since we're using OAuth now
    console.log('Your .env should now have:');
    console.log(`  GDRIVE_CLIENT_ID=${CLIENT_ID}`);
    console.log(`  GDRIVE_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`  GDRIVE_REFRESH_TOKEN=${refreshToken}`);
    console.log(`  GDRIVE_FOLDER_ID=${process.env.GDRIVE_FOLDER_ID || 'your_folder_id'}`);
    console.log('');
    console.log('You can now run the upload script!');

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>✅ Authorization successful!</h1><p>You can close this tab. Check your terminal.</p>');

    server.close();
    process.exit(0);
  } catch (err: any) {
    console.error('❌ Failed to exchange code:', err.message);
    res.writeHead(500);
    res.end('Failed to exchange authorization code');
  }
});

server.listen(9876);
