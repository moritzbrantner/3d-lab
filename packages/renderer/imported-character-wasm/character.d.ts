/* tslint:disable */
/* eslint-disable */

export class CharacterAsset {
    free(): void;
    [Symbol.dispose](): void;
    create_instance(): CharacterInstance;
    metadata_json(): string;
    constructor(bytes: Uint8Array);
}

export class CharacterInstance {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    advance(seconds: number): void;
    local_matrices(): Float32Array;
    seek(clip: string, seconds: number): void;
    transition(clip: string, seconds: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_characterasset_free: (a: number, b: number) => void;
    readonly __wbg_characterinstance_free: (a: number, b: number) => void;
    readonly characterasset_create_instance: (a: number) => number;
    readonly characterasset_metadata_json: (a: number) => [number, number];
    readonly characterasset_new: (a: number, b: number) => [number, number, number];
    readonly characterinstance_advance: (a: number, b: number) => [number, number];
    readonly characterinstance_local_matrices: (a: number) => [number, number];
    readonly characterinstance_seek: (a: number, b: number, c: number, d: number) => [number, number];
    readonly characterinstance_transition: (a: number, b: number, c: number, d: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
