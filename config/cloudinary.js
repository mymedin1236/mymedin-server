import { v2 as cloudinary } from "cloudinary";

// Configure from the three split vars, or from a single CLOUDINARY_URL
// (cloudinary://<api_key>:<api_secret>@<cloud_name>), which the SDK reads
// automatically from the environment when present.
if (process.env.CLOUDINARY_CLOUD_NAME) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

// True once credentials are available — lets routes return a clean 503 instead
// of throwing when image uploads aren't configured yet.
export const cloudinaryReady = () =>
  !!(cloudinary.config().cloud_name || process.env.CLOUDINARY_URL);

export default cloudinary;
