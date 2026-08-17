// heic2any ships no types. Minimal ambient declaration for the API we use
// (browser-only; imported dynamically in the upload flow).
declare module "heic2any" {
  interface Heic2AnyOptions {
    blob: Blob;
    toType?: string; // e.g. "image/jpeg"
    quality?: number; // 0..1
    multiple?: boolean;
  }
  export default function heic2any(options: Heic2AnyOptions): Promise<Blob | Blob[]>;
}
