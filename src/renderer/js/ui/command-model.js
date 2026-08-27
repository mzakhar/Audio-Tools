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
  midiInput: null,
}

export function commandItems(opts = {}) {
  const { mode, projectOpen, recording, midiInput } = { ...DEFAULTS, ...(opts || {}) }

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
      label: recording ? 'Stop recording' : (isArrange ? 'Record MIDI' : 'Record audio'),
      shortcut: null,
      group: 'transport',
      enabled: true,
      visible: true,
    },
    {
      id: 'new',
      label: 'New',
      shortcut: 'Ctrl+N',
      group: 'project',
      enabled: true,
      visible: true,
    },
    {
      id: 'open',
      label: 'Open',
      shortcut: 'Ctrl+O',
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
      enabled: true,
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
      id: 'library',
      label: 'Library',
      shortcut: 'Ctrl+L',
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
