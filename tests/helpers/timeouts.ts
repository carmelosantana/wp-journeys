/**
 * For a test that spawns `node` (R95a). One spawn takes about 0.45 s on an idle machine and was
 * seen at 6.2 s under load, past vitest's 5 s default. spawnSync blocks the worker, so a generous
 * ceiling costs a healthy run nothing — and a result that depends on machine load is a defect.
 */
export const SPAWN_TIMEOUT_MS = 30_000;
