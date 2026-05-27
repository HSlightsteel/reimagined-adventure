import 'dotenv/config';

interface TikTokConfig {
  sessionId: string;
  idc: string;
  proxy?: string;
}

interface TelegramConfig {
  apiId?: number;
  apiHash?: string;
  botToken?: string;
  chatId: string;
}

interface GoogleDriveConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  folderId?: string;
}

interface ApiConfig {
  port: number;
}

export interface Config {
  tiktok: TikTokConfig;
  telegram: TelegramConfig;
  gdrive: GoogleDriveConfig;
  api: ApiConfig;
}

export const env: Config = {
  tiktok: {
    sessionId: process.env.TIKTOK_SESSIONID_SS || '',
    idc: process.env.TIKTOK_IDC || 'useast2a',
    proxy: process.env.TIKTOK_PROXY,
  },
  telegram: {
    apiId: process.env.TELEGRAM_API_ID ? Number(process.env.TELEGRAM_API_ID) : undefined,
    apiHash: process.env.TELEGRAM_API_HASH,
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID || '-3104506824',
  },
  gdrive: {
    clientId: process.env.GDRIVE_CLIENT_ID,
    clientSecret: process.env.GDRIVE_CLIENT_SECRET,
    refreshToken: process.env.GDRIVE_REFRESH_TOKEN,
    folderId: process.env.GDRIVE_FOLDER_ID,
  },
  api: {
    port: process.env.API_PORT ? Number(process.env.API_PORT) : 3000,
  },
};

if (!env.tiktok.sessionId) {
  throw new Error('TIKTOK_SESSIONID_SS is required in environment variables');
}