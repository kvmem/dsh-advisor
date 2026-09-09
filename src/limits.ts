// Adapter/model limits remain authoritative; these are local configuration bounds.
export const MAX_OUTPUT_TOKENS = 1_000_000
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
// JSON may escape each input byte as six ASCII bytes, plus the result envelope.
export const MAX_RESULT_FILE_BYTES = MAX_OUTPUT_BYTES * 6 + 4096
