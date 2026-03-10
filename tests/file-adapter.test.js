import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BrowserAdapter, ElectronAdapter, validateProjectPath } from '../src/renderer/js/io/FileAdapter.js'

// ─── Mock factory helpers ────────────────────────────────────────────────────

function makeMockDirectoryHandle(files = {}) {
  return {
    getFileHandle: vi.fn(async (name, opts) => makeMockFileHandle(files[name] || '')),
    getDirectoryHandle: vi.fn(async () => makeMockDirectoryHandle()),
  }
}

function makeMockFileHandle(content = '') {
  return {
    getFile: vi.fn(async () => ({
      text: async () => content,
      arrayBuffer: async () => new ArrayBuffer(0),
      name: 'test.wav'
    })),
    createWritable: vi.fn(async () => ({
      write: vi.fn(),
      close: vi.fn()
    }))
  }
}

// ─── BrowserAdapter tests ─────────────────────────────────────────────────────

describe('BrowserAdapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('openProjectFolder', () => {
    it('calls window.showDirectoryPicker with mode: readwrite', async () => {
      const mockDirHandle = makeMockDirectoryHandle()
      window.showDirectoryPicker = vi.fn(async () => mockDirHandle)

      await BrowserAdapter.openProjectFolder()

      expect(window.showDirectoryPicker).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'readwrite' })
      )
    })

    it('returns the directory handle from showDirectoryPicker', async () => {
      const mockDirHandle = makeMockDirectoryHandle()
      window.showDirectoryPicker = vi.fn(async () => mockDirHandle)

      const result = await BrowserAdapter.openProjectFolder()
      expect(result).toBe(mockDirHandle)
    })

    it('returns null if user cancels (throws AbortError)', async () => {
      const abortError = new DOMException('User aborted', 'AbortError')
      window.showDirectoryPicker = vi.fn(async () => { throw abortError })

      const result = await BrowserAdapter.openProjectFolder()
      expect(result).toBeNull()
    })
  })

  describe('writeProject', () => {
    it('calls createWritable on the file handle', async () => {
      const mockFileHandle = makeMockFileHandle()
      const mockDirHandle = {
        getFileHandle: vi.fn(async () => mockFileHandle),
        getDirectoryHandle: vi.fn(async () => makeMockDirectoryHandle()),
      }

      const state = { bpm: 120, tracks: [], mixer: { channels: [], master: { volume: 1 } }, patterns: {}, version: 1 }
      await BrowserAdapter.writeProject(mockDirHandle, state)

      expect(mockFileHandle.createWritable).toHaveBeenCalled()
    })

    it('writes JSON-serialized state', async () => {
      const mockWritable = { write: vi.fn(), close: vi.fn() }
      const mockFileHandle = {
        getFile: vi.fn(),
        createWritable: vi.fn(async () => mockWritable)
      }
      const mockDirHandle = {
        getFileHandle: vi.fn(async () => mockFileHandle),
        getDirectoryHandle: vi.fn(async () => makeMockDirectoryHandle()),
      }

      const state = { bpm: 120, tracks: [], mixer: { channels: [], master: { volume: 1 } }, patterns: {}, version: 1 }
      await BrowserAdapter.writeProject(mockDirHandle, state)

      expect(mockWritable.write).toHaveBeenCalledWith(
        expect.stringContaining('"bpm"')
      )
    })

    it('closes the writable after writing', async () => {
      const mockWritable = { write: vi.fn(), close: vi.fn() }
      const mockFileHandle = {
        getFile: vi.fn(),
        createWritable: vi.fn(async () => mockWritable)
      }
      const mockDirHandle = {
        getFileHandle: vi.fn(async () => mockFileHandle),
        getDirectoryHandle: vi.fn(async () => makeMockDirectoryHandle()),
      }

      const state = { bpm: 120, tracks: [], mixer: { channels: [], master: { volume: 1 } }, patterns: {}, version: 1 }
      await BrowserAdapter.writeProject(mockDirHandle, state)

      expect(mockWritable.close).toHaveBeenCalled()
    })
  })

  describe('importAudio', () => {
    it('copies file to audio/ subfolder and returns relative path', async () => {
      const mockFile = {
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(8),
        name: 'sample.wav'
      }
      const mockSrcHandle = {
        getFile: vi.fn(async () => mockFile)
      }
      const mockWritable = { write: vi.fn(), close: vi.fn() }
      const mockDestHandle = {
        getFile: vi.fn(),
        createWritable: vi.fn(async () => mockWritable)
      }
      const mockAudioDirHandle = {
        getFileHandle: vi.fn(async () => mockDestHandle),
        getDirectoryHandle: vi.fn(async () => makeMockDirectoryHandle()),
      }
      const mockDirHandle = {
        getFileHandle: vi.fn(async () => makeMockFileHandle()),
        getDirectoryHandle: vi.fn(async (name, opts) => mockAudioDirHandle),
      }

      const result = await BrowserAdapter.importAudio(mockSrcHandle, mockDirHandle)

      expect(result).toBe('audio/sample.wav')
    })

    it('creates the audio directory with create: true', async () => {
      const mockFile = {
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(8),
        name: 'beat.wav'
      }
      const mockSrcHandle = {
        getFile: vi.fn(async () => mockFile)
      }
      const mockWritable = { write: vi.fn(), close: vi.fn() }
      const mockDestHandle = {
        getFile: vi.fn(),
        createWritable: vi.fn(async () => mockWritable)
      }
      const mockAudioDirHandle = {
        getFileHandle: vi.fn(async () => mockDestHandle),
        getDirectoryHandle: vi.fn(async () => makeMockDirectoryHandle()),
      }
      const mockDirHandle = {
        getFileHandle: vi.fn(async () => makeMockFileHandle()),
        getDirectoryHandle: vi.fn(async (name, opts) => mockAudioDirHandle),
      }

      await BrowserAdapter.importAudio(mockSrcHandle, mockDirHandle)

      expect(mockDirHandle.getDirectoryHandle).toHaveBeenCalledWith(
        'audio',
        expect.objectContaining({ create: true })
      )
    })
  })
})

// ─── ElectronAdapter tests ────────────────────────────────────────────────────

describe('ElectronAdapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // Provide a clean mock for window.electronFS before each test
    window.electronFS = {
      showOpenDialog: vi.fn(),
      readProject: vi.fn(),
      writeProject: vi.fn(),
      copyFile: vi.fn(),
    }
  })

  describe('openProjectFolder', () => {
    it('calls window.electronFS.showOpenDialog with openDirectory property', async () => {
      window.electronFS.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/projects/my-song'] })

      await ElectronAdapter.openProjectFolder()

      expect(window.electronFS.showOpenDialog).toHaveBeenCalledWith(
        expect.objectContaining({ properties: expect.arrayContaining(['openDirectory']) })
      )
    })

    it('returns the selected directory path', async () => {
      window.electronFS.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/projects/my-song'] })

      const result = await ElectronAdapter.openProjectFolder()
      expect(result).toBe('/projects/my-song')
    })

    it('returns null if user cancels the dialog', async () => {
      window.electronFS.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })

      const result = await ElectronAdapter.openProjectFolder()
      expect(result).toBeNull()
    })

    it('returns null if filePaths is empty', async () => {
      window.electronFS.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [] })

      const result = await ElectronAdapter.openProjectFolder()
      expect(result).toBeNull()
    })
  })

  describe('readProject', () => {
    it('calls window.electronFS.readProject with the directory path', async () => {
      const mockState = { bpm: 120, tracks: [], mixer: { channels: [], master: { volume: 1 } }, patterns: {}, version: 1 }
      window.electronFS.readProject.mockResolvedValue(mockState)

      await ElectronAdapter.readProject('/projects/my-song')

      expect(window.electronFS.readProject).toHaveBeenCalledWith('/projects/my-song')
    })

    it('returns object with state and dirHandle', async () => {
      const mockState = { bpm: 120, tracks: [], mixer: { channels: [], master: { volume: 1 } }, patterns: {}, version: 1 }
      window.electronFS.readProject.mockResolvedValue(mockState)

      const result = await ElectronAdapter.readProject('/projects/my-song')

      expect(result).toHaveProperty('state')
      expect(result).toHaveProperty('dirHandle')
    })

    it('returns dirHandle equal to the provided path', async () => {
      const mockState = { bpm: 140, tracks: [] }
      window.electronFS.readProject.mockResolvedValue(mockState)

      const result = await ElectronAdapter.readProject('/projects/my-song')
      expect(result.dirHandle).toBe('/projects/my-song')
    })

    it('returned state matches what electronFS.readProject resolves', async () => {
      const mockState = { bpm: 140, tracks: [], version: 1 }
      window.electronFS.readProject.mockResolvedValue(mockState)

      const result = await ElectronAdapter.readProject('/projects/my-song')
      expect(result.state.bpm).toBe(140)
    })
  })

  describe('writeProject', () => {
    it('calls window.electronFS.writeProject with path and state', async () => {
      window.electronFS.writeProject.mockResolvedValue(undefined)
      const state = { bpm: 120, tracks: [], mixer: { channels: [], master: { volume: 1 } }, patterns: {}, version: 1 }

      await ElectronAdapter.writeProject('/projects/my-song', state)

      expect(window.electronFS.writeProject).toHaveBeenCalledWith('/projects/my-song', state)
    })
  })
})

// ─── validateProjectPath tests (file-adapter context) ─────────────────────────

describe('validateProjectPath (from FileAdapter)', () => {
  it('returns true for a safe relative audio path', () => {
    expect(validateProjectPath('/project', 'audio/sample.wav')).toBe(true)
  })

  it('returns false for a traversal path', () => {
    expect(validateProjectPath('/project', '../other.wav')).toBe(false)
  })

  it('returns false for an empty path', () => {
    expect(validateProjectPath('/project', '')).toBe(false)
  })
})
