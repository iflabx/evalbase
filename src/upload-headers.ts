// Keep the raw upload stream while transporting UTF-8 metadata in ByteString headers.
export const UPLOAD_HEADER_ENCODING = "percent-utf8";

export function encodeUploadHeader(value: string): string {
  return encodeURIComponent(value);
}

export function decodeUploadHeader(value: string, encoded: boolean): string {
  return encoded ? decodeURIComponent(value) : value;
}
