// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { sha256Hex } from '../src/renderer/js/fm1/sha256.js'
import { FM1_WASM_SHA256, FM1_EMU_COMMIT } from '../src/renderer/js/fm1/wasm-pin.js'

describe('shipped FM-1 wasm', () => {
  it('matches the pinned sha256', () => {
    const bytes = readFileSync(resolve(process.cwd(), 'src/renderer/public/fm1/fm1_web.wasm'))
    expect(sha256Hex(bytes)).toBe(FM1_WASM_SHA256)
  })

  it('NOTICE names the pinned commit and hash', () => {
    const notice = readFileSync(resolve(process.cwd(), 'src/renderer/public/fm1/NOTICE'), 'utf8')
    expect(notice).toContain(FM1_EMU_COMMIT)
    expect(notice).toContain(FM1_WASM_SHA256)
    expect(notice).toContain('MIT License')
  })
})
