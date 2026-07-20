const fs = require('fs');
const path = require('path');
const cloudinary = require('cloudinary').v2;
const sharp = require('sharp');
require('dotenv').config();

cloudinary.config({ secure: true });

const imageDir = process.env.BOLONCITY_IMAGE_DIR;
const outputFile = path.join(__dirname, 'images.json');

async function uploadImages() {
  try {
    if (!imageDir) throw new Error('BOLONCITY_IMAGE_DIR is required');
    const files = fs.readdirSync(imageDir).filter(f => f.endsWith('.jpg') || f.endsWith('.png'));
    console.log(`Found ${files.length} images to upload.`);
    
    const results = [];
    
    for (const file of files) {
      const filePath = path.join(imageDir, file);
      console.log(`Processing & Uploading ${file}...`);
      
      try {
        // Compress and resize using sharp to get below 10MB
        const buffer = await sharp(filePath)
          .resize({ width: 1920, withoutEnlargement: true })
          .jpeg({ quality: 80 })
          .toBuffer();

        // Upload using stream since we have a buffer
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: 'boloncity' },
            (error, result) => {
              if (error) reject(error);
              else resolve(result);
            }
          );
          stream.end(buffer);
        });
        
        results.push({
          filename: file,
          url: result.secure_url,
          public_id: result.public_id,
          description: `Imagen conceptual o de producto de Boloncity - ${file}`
        });
        console.log(`Uploaded ${file} successfully.`);
      } catch (uploadError) {
        console.error(`Failed to upload ${file}:`, uploadError);
      }
    }
    
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`Finished uploading. Results written to ${outputFile}`);
    
  } catch (error) {
    console.error('Error in upload script:', error);
  }
}

uploadImages();
