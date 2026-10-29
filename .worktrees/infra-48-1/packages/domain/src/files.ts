import { DEFAULT_RESOURCE_PROFILE } from './resource-profile';
/** Transfer sizes in bytes; multipart checksums use these exact part boundaries. */
export const SINGLE_UPLOAD_BYTES = 64 * 1024 * 1024;
export const UPLOAD_PART_BYTES = 16 * 1024 * 1024;
export const DOWNLOAD_LIFETIME_MS = 15 * 60 * 1000;
export const DOWNLOAD_NOT_FOUND = 'Not found';
export const TEXT_PREVIEW_BYTES = DEFAULT_RESOURCE_PROFILE.chosen.preview.textBytes;
export const CSV_PREVIEW_ROWS = DEFAULT_RESOURCE_PROFILE.chosen.preview.csvRows;
