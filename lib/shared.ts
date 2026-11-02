// Constantes usadas pelo servidor e pelo navegador.
export const SYNC_STORES = ['stops', 'deliveries', 'expenses', 'routes', 'tracks'] as const;
export type SyncStore = (typeof SYNC_STORES)[number];

// Configurações (kv) que vão para a conta. O pacote offline e o cache de endereços ficam só no aparelho.
export const SYNC_KV = ['profiles', 'lastProfile', 'pay', 'target', 'city', 'learnOn', 'keepOn', 'voice', 'avatar', 'hazards', 'devzones', 'speedmap'] as const;

export const BACKUP_OPTIONS = [5, 10, 15, 60, 120] as const;
export type BackupMinutes = (typeof BACKUP_OPTIONS)[number];
export const DEFAULT_BACKUP_MINUTES: BackupMinutes = 60;

export const isBackupMinutes = (n: unknown): n is BackupMinutes => BACKUP_OPTIONS.includes(n as BackupMinutes);

export interface SyncChange { store: string; id: string; data: unknown; deleted: boolean; ts: number }
export interface User { id: string; email: string; name: string }
