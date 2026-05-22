export type ElectronSoundId =
  | 'app-start'
  | 'app-ready'
  | 'click-soft'
  | 'click-crisp'
  | 'hover-tick'
  | 'toggle-on'
  | 'toggle-off'
  | 'confirm'
  | 'success'
  | 'warning'
  | 'error'
  | 'notification'
  | 'message'
  | 'modal-open'
  | 'modal-close'
  | 'drawer-open'
  | 'drawer-close'
  | 'drop'
  | 'drag-start'
  | 'delete'
  | 'undo'
  | 'save'
  | 'search'
  | 'loading-pulse'
  | 'focus-ring'
  | 'navigation-back'
  | 'navigation-forward';

export interface ElectronSoundEntry {
  id: ElectronSoundId;
  file: string;
  category: string;
  description: string;
  durationMs: number;
  recommendedVolume: number;
  loop: boolean;
}

export interface ElectronSoundManifest {
  name: string;
  version: string;
  sampleRate: number;
  channels: number;
  format: string;
  license: string;
  sounds: ElectronSoundEntry[];
}

export interface SoundPlayerOptions {
  manifestUrl?: URL | string;
  baseUrl?: URL | string;
  enabled?: boolean;
  volume?: number;
}

export interface PlayOptions {
  volume?: number;
  loop?: boolean;
}

export interface ElectronSoundPlayer {
  manifest: ElectronSoundManifest;
  preload(ids?: ElectronSoundId[]): Promise<void>;
  play(id: ElectronSoundId, options?: PlayOptions): Promise<AudioBufferSourceNode | null>;
  setEnabled(value: boolean): void;
  setVolume(value: number): void;
  readonly enabled: boolean;
  readonly volume: number;
}

export function createSoundPlayer(options?: SoundPlayerOptions): Promise<ElectronSoundPlayer>;
