/**
 * command-model.js
 * Pure list of command-bar / ⋯-menu items derived from app state. No DOM.
 *
 * Both the command bar and the ⋯ menu render from this one list so a control
 * can never be enabled in one place and dead in the other.
 */

const DEFAULTS = {
  mode: 'synth',
  projectOpen: false,
  recording: false,
  masterRecording: false,
  canRecordMaster: true,
  midiInput: null,
  canImportPacks: true,
  assistant: false,
  fm1Armed: false,
}

export function commandItems(opts = {}) {
  const { mode, projectOpen, recording, masterRecording, canRecordMaster, midiInput, canImportPacks, assistant, fm1Armed } = { ...DEFAULTS, ...(opts || {}) }

  const isArrange = mode === 'arrange'

  return [
    {
      id: 'play',
      label: 'Play',
      shortcut: null,
      group: 'transport',
      // The 909 is its own view with its own Bar/Chain transport.
      enabled: mode !== 'tr909',
      visible: true,
    },
    {
      id: 'stop',
      label: 'Stop',
      shortcut: null,
      group: 'transport',
      enabled: true,
      visible: true,
    },
    {
      id: 'record',
      // The header ●: a MIDI take in Arrange. recording = a take is open.
      label: recording ? 'Stop recording' : 'Record MIDI',
      shortcut: null,
      group: 'transport',
      enabled: isArrange,
      visible: true,
    },
    {
      id: 'new',
      label: 'New',
      shortcut: 'Ctrl+Shift+N',
      group: 'project',
      enabled: true,
      visible: true,
    },
    {
      id: 'open',
      label: 'Open',
      shortcut: 'Ctrl+Shift+O',
      group: 'project',
      enabled: true,
      visible: true,
    },
    {
      id: 'save',
      label: 'Save',
      shortcut: 'Ctrl+S',
      group: 'project',
      enabled: projectOpen,
      visible: true,
    },
    {
      id: 'import-audio',
      label: 'Import audio',
      shortcut: null,
      group: 'add',
      enabled: projectOpen,
      visible: true,
    },
    {
      id: 'add-midi-track',
      label: '+ MIDI track',
      shortcut: null,
      group: 'add',
      enabled: projectOpen,
      visible: true,
    },
    {
      id: 'bounce',
      label: 'Bounce',
      shortcut: 'Ctrl+B',
      group: 'add',
      enabled: projectOpen,
      visible: true,
    },
    {
      id: 'import-pack',
      label: 'Import pack',
      shortcut: null,
      group: 'add',
      // True when either backend exists (Electron IPC, or IndexedDB in the
      // browser). A live-looking item that no-ops is worse than a disabled one.
      enabled: !!canImportPacks,
      visible: true,
    },
    {
      id: 'add-track',
      label: '+ Track',
      shortcut: null,
      group: 'add',
      enabled: true,
      visible: isArrange,
    },
    {
      id: 'midi-setup',
      label: 'MIDI setup',
      shortcut: 'Ctrl+M',
      group: 'setup',
      enabled: true,
      visible: true,
    },
    {
      id: 'controller-map',
      label: 'Controller map…',
      shortcut: null,
      group: 'setup',
      enabled: true,
      visible: true,
    },
    {
      id: 'lessons',
      label: 'Lessons…',
      shortcut: null,
      group: 'setup',
      enabled: true,
      visible: true,
    },
    {
      id: 'fm1-library',
      label: 'FM-1 firmware…',
      shortcut: null,
      group: 'setup',
      enabled: true,
      visible: true,
    },
    {
      id: 'fm1-device',
      label: 'FM-1 device…',
      shortcut: null,
      group: 'setup',
      // Opens the armed track's device; with no FM-1 track armed there is nothing to open.
      enabled: !!fm1Armed,
      visible: true,
    },
    {
      id: 'fm1-record',
      label: 'Record FM-1 to audio track…',
      shortcut: null,
      group: 'setup',
      // Captures the armed FM-1 track into an audio track of the open project.
      enabled: !!projectOpen && !!fm1Armed,
      visible: true,
    },
    {
      id: 'record-master',
      // A toggle: the menu label is the way back out.
      // The recorder is a worklet: on plain http it is shown disabled, with the reason.
      label: masterRecording ? 'Stop master recording' : canRecordMaster ? 'Record master to WAV…' : 'Record master to WAV (needs HTTPS)',
      shortcut: null,
      group: 'setup',
      enabled: masterRecording || canRecordMaster,
      visible: true,
    },
    {
      id: 'library',
      label: 'Library',
      shortcut: 'Ctrl+Shift+L',
      group: 'setup',
      enabled: true,
      visible: true,
    },
    {
      id: 'mixer',
      label: 'Mixer',
      shortcut: 'Ctrl+Shift+M',
      group: 'setup',
      enabled: true,
      visible: isArrange,
    },
    {
      id: 'assistant',
      label: 'Assistant',
      shortcut: 'Ctrl+Shift+A',
      group: 'setup',
      // No route, no entry: an item that cannot work does not exist here.
      enabled: true,
      visible: !!assistant,
    },
    {
      id: 'instrument-browser',
      label: 'Instrument browser',
      shortcut: 'Ctrl+I',
      group: 'setup',
      enabled: true,
      visible: true,
    },
    {
      id: 'theme',
      label: 'Theme',
      shortcut: null,
      group: 'setup',
      enabled: true,
      visible: true,
    },
    {
      id: 'midi-token',
      label: midiInput,
      shortcut: null,
      group: 'setup',
      enabled: true,
      visible: !!midiInput,
    },
  ]
}
