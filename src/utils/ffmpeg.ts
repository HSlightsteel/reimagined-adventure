import { spawn } from 'node:child_process';
import { unlink, writeFile } from 'node:fs/promises';
import { logger } from './logger';

export async function convertFlvToMp4(
  input: string,
  output: string,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    logger.info({ input, output }, 'Starting FLV to MP4 conversion');

    // Added aac_adtstoasc bitstream filter for robust audio compatibility in MP4 containers
    // Added -movflags +faststart to move moov atom to the front for instant web streaming
    const ffmpeg = spawn('ffmpeg', ['-y', '-i', input, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', output]);

    const onAbort = (): void => {
      ffmpeg.kill('SIGTERM');
      reject(new Error('FFmpeg conversion aborted'));
    };

    signal?.addEventListener('abort', onAbort);

    let stderr = '';

    ffmpeg.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    ffmpeg.on('close', async (code) => {
      signal?.removeEventListener('abort', onAbort);

      if (code === 0) {
        logger.info({ output }, 'FFmpeg conversion completed successfully');
        
        // Delete original FLV file
        try {
          await unlink(input);
          logger.debug({ input }, 'Deleted original FLV file');
        } catch (err) {
          logger.warn({ input, err }, 'Failed to delete original FLV file');
        }
        
        resolve();
      } else {
        logger.error({ code, stderr }, 'FFmpeg conversion failed');
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr}`));
      }
    });

    ffmpeg.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      logger.error({ err }, 'FFmpeg process error');
      reject(err);
    });
  });
}

async function getVideoCodec(filePath: string): Promise<string> {
  return new Promise((resolve) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let out = '';
    ffprobe.stdout.on('data', (d) => out += d.toString());
    ffprobe.on('close', (code) => {
      resolve(code === 0 ? out.trim().toLowerCase() : 'h264');
    });
    ffprobe.on('error', () => resolve('h264'));
  });
}

export async function concatFlvToMp4(
  inputPaths: string[],
  output: string,
  signal?: AbortSignal
): Promise<void> {
  logger.info({ chunks: inputPaths.length, output }, 'Starting FFmpeg chunk concatenation via intermediate TS files');

  const tsPaths: string[] = [];
  try {
    // 1. Convert each FLV to TS using the correct bitstream filter to make streams fully combinable
    for (let i = 0; i < inputPaths.length; i++) {
      const flv = inputPaths[i]!;
      const ts = `${flv}.ts`;
      tsPaths.push(ts);

      const codec = await getVideoCodec(flv);
      logger.debug({ flv, ts, codec }, 'Converting FLV chunk to TS');

      const bsfArgs: string[] = [];
      if (codec === 'h264') {
        bsfArgs.push('-bsf:v', 'h264_mp4toannexb');
      } else if (codec === 'hevc' || codec === 'h265') {
        bsfArgs.push('-bsf:v', 'hevc_mp4toannexb');
      }

      await new Promise<void>((resolve, reject) => {
        const ffmpegArgs = [
          '-y',
          '-i', flv,
          '-c', 'copy',
          ...bsfArgs,
          '-f', 'mpegts',
          ts
        ];

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);

        let stderr = '';
        ffmpeg.stderr.on('data', (d) => stderr += d.toString());
        ffmpeg.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Failed to convert FLV to TS (exited with ${code}): ${stderr}`));
        });
        ffmpeg.on('error', reject);
      });
    }

    // 2. Concat the TS files to MP4
    const concatString = `concat:${tsPaths.join('|')}`;
    logger.info({ concatString, output }, 'Concatenating TS files to MP4');

    await new Promise<void>((resolve, reject) => {
      const ffmpeg = spawn('ffmpeg', [
        '-y',
        '-i', concatString,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', '+faststart',
        output
      ]);

      let stderr = '';
      ffmpeg.stderr.on('data', (d) => stderr += d.toString());
      ffmpeg.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Failed to concat TS to MP4 (exited with ${code}): ${stderr}`));
      });
      ffmpeg.on('error', reject);
    });

    // 3. Clean up all temporary FLV & TS files
    logger.debug('Cleaning up temporary FLV chunks and intermediate TS files');
    for (const flv of inputPaths) {
      try { await unlink(flv); } catch {}
    }
    for (const ts of tsPaths) {
      try { await unlink(ts); } catch {}
    }

  } catch (err) {
    logger.error({ err }, 'FFmpeg TS concat failed, cleaning up temp files');
    for (const ts of tsPaths) {
      try { await unlink(ts); } catch {}
    }
    throw err;
  }
}