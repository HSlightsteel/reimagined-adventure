const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const dir = path.join(__dirname, 'recordings');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.mp4') && !f.startsWith('fixed_'));

async function repair() {
  console.log(`Found ${files.length} MP4 files to repair.`);
  
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const input = `/app/recordings/${file}`;
    const temp = `/app/recordings/fixed_${file}`;
    const hostTemp = path.join(dir, `fixed_${file}`);
    const hostInput = path.join(dir, file);
    
    console.log(`\n[${i+1}/${files.length}] Repairing ${file}...`);
    
    try {
      await new Promise((resolve, reject) => {
        const ff = spawn('docker', [
          'exec', 'tiktok-live-recorder', 
          'ffmpeg', '-y', 
          '-err_detect', 'ignore_err', 
          '-i', input, 
          '-c', 'copy', 
          '-fflags', '+genpts', 
          '-bsf:a', 'aac_adtstoasc', 
          temp
        ]);
        
        let errorOutput = '';
        ff.stderr.on('data', d => {
            // FFmpeg prints everything to stderr. Just collect it to show if it fails.
            errorOutput += d.toString();
        });
        
        ff.on('close', code => {
          if (code === 0) resolve();
          else reject(new Error(`Exit code ${code}:\n${errorOutput.slice(-500)}`));
        });
      });

      // Check if temp file was created successfully
      if (fs.existsSync(hostTemp) && fs.statSync(hostTemp).size > 0) {
        fs.unlinkSync(hostInput); // Delete old corrupt file
        fs.renameSync(hostTemp, hostInput); // Replace with fixed file
        console.log(`✅ Successfully repaired and replaced ${file}`);
      } else {
        console.log(`⚠️ Repair failed or generated empty file for ${file}. Skipping.`);
        if (fs.existsSync(hostTemp)) fs.unlinkSync(hostTemp);
      }
    } catch (err) {
      console.log(`❌ Failed to repair ${file}: ${err.message}`);
      if (fs.existsSync(hostTemp)) fs.unlinkSync(hostTemp);
    }
  }
  console.log('\n🎉 All repairs completed!');
}

repair().catch(err => console.error('Script Error:', err));
