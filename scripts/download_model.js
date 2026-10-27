/**
 * scripts/download_model.js
 * Downloads the COCO-SSD lite_mobilenet_v2 model files into assets/model/
 * for 100% offline local browser execution.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const BASE_URL = 'https://storage.googleapis.com/tfjs-models/savedmodel/ssdlite_mobilenet_v2/';
const TARGET_DIR = path.join(__dirname, '..', 'assets', 'model');

if (!fs.existsSync(TARGET_DIR)) {
  fs.mkdirSync(TARGET_DIR, { recursive: true });
}

const files = [
  'model.json',
  'group1-shard1of5',
  'group1-shard2of5',
  'group1-shard3of5',
  'group1-shard4of5',
  'group1-shard5of5'
];

function downloadFile(fileName) {
  return new Promise((resolve, reject) => {
    const fileUrl = BASE_URL + fileName;
    const destPath = path.join(TARGET_DIR, fileName);
    const fileStream = fs.createWriteStream(destPath);

    console.log(`Downloading ${fileName}...`);
    https.get(fileUrl, (response) => {
      if (response.statusCode !== 200) {
        return reject(new Error(`Failed to get '${fileName}' (${response.statusCode})`));
      }
      response.pipe(fileStream);
      fileStream.on('finish', () => {
        fileStream.close();
        console.log(`Saved ${fileName} (${fs.statSync(destPath).size} bytes)`);
        resolve();
      });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

async function main() {
  console.log('Starting offline COCO-SSD model download...');
  for (const f of files) {
    try {
      await downloadFile(f);
    } catch (e) {
      console.error(`Error downloading ${f}:`, e.message);
    }
  }
  console.log('Model download complete. Files located in assets/model/');
}

main();
