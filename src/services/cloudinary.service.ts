import { v2 as cloudinary } from "cloudinary";
import { env } from "../config/env";

const cloudinaryConfigured =
  !!env.CLOUDINARY_URL ||
  (!!env.CLOUDINARY_CLOUD_NAME && !!env.CLOUDINARY_API_KEY && !!env.CLOUDINARY_API_SECRET);

if (env.CLOUDINARY_URL) {
  cloudinary.config({ secure: true });
} else if (cloudinaryConfigured) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
  });
}

export function isCloudinaryConfigured() {
  return cloudinaryConfigured;
}

export async function uploadToCloudinary(fileBuffer: Buffer, folder: string, publicId?: string) {
  if (!cloudinaryConfigured) {
    throw new Error("Cloudinary is not configured");
  }

  return new Promise<{ secure_url: string; public_id: string }>((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, overwrite: true, resource_type: "image" },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error("Cloudinary upload failed"));
          return;
        }
        resolve(result);
      }
    );

    stream.end(fileBuffer);
  });
}

export async function deleteFromCloudinary(publicId: string) {
  if (!publicId) return;
  if (!cloudinaryConfigured) return;
  await cloudinary.uploader.destroy(publicId);
}
