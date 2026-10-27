// Minimal local declaration for the `he` package (used for type checking only).
declare module 'he' {
  export function decode(html: string, options?: { isAttributeValue?: boolean; strict?: boolean }): string;
  export function encode(text: string, options?: Record<string, unknown>): string;
}
