import z from '@deepseek-ai/schemastery'
import { integer } from './model.js'

// Bounds for optional custom limits. Zero removes the plugin's override/cap.
export const MAX_OUTPUT_TOKENS = 1_000_000
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
export const OutputTokensSchema = z.union([z.const(0), z.number().step(1).min(128).max(MAX_OUTPUT_TOKENS)]).default(0)
export const OutputBytesSchema = z.union([z.const(0), z.number().step(1).min(1024).max(MAX_OUTPUT_BYTES)]).default(0)
export function outputLimit(value: number | undefined, min: number, max: number): number {
  return value === undefined || value === 0 ? 0 : integer(value, min, max)
}
