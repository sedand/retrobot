import Piscina from 'piscina';
import { CoreType } from './emulate';
import { crc32 } from 'hash-wasm';
import { InputState, loadRom, loadState, saveState } from './util';

export const RETRO_DEVICE_ID_JOYPAD_B = 0;
export const RETRO_DEVICE_ID_JOYPAD_Y = 1;
export const RETRO_DEVICE_ID_JOYPAD_SELECT = 2;
export const RETRO_DEVICE_ID_JOYPAD_START = 3;
export const RETRO_DEVICE_ID_JOYPAD_UP = 4;
export const RETRO_DEVICE_ID_JOYPAD_DOWN = 5;
export const RETRO_DEVICE_ID_JOYPAD_LEFT = 6;
export const RETRO_DEVICE_ID_JOYPAD_RIGHT = 7;
export const RETRO_DEVICE_ID_JOYPAD_A = 8;
export const RETRO_DEVICE_ID_JOYPAD_X = 9;
export const RETRO_DEVICE_ID_JOYPAD_L = 10;
export const RETRO_DEVICE_ID_JOYPAD_R = 11;
export const RETRO_DEVICE_ID_JOYPAD_L2 = 12;
export const RETRO_DEVICE_ID_JOYPAD_R2 = 13;
export const RETRO_DEVICE_ID_JOYPAD_L3 = 14;
export const RETRO_DEVICE_ID_JOYPAD_R3 = 15;

export const RETRO_DEVICE_ID_JOYPAD_MASK = 256;

type Core = any

export interface Frame {
    buffer: Uint16Array
    width: number
    height: number
    pitch: number
}

export interface WorkerData {
    input: InputState
    duration: number
    coreType: CoreType
    game: Buffer
    state: Buffer
    gameHash?: string
}

const NesCore = require('../cores/quicknes_libretro');
const SnesCore = require('../cores/snes9x2010_libretro');
const GbCore = require('../cores/mgba_libretro');

let lastGbGameHash = '';
let lastNesGameHash = '';
let lastSnesGameHash = '';

const setup = (core: Core) => {
    core.retro_set_environment((cmd: number, data: any) => {
        if (cmd == 3) {
            core.HEAPU8[data] = 1;
            return true;
        }

        if (cmd == (51 | 0x10000)) {
            return true;
        }

        if (cmd == 10) {
            return true;
        }

        return false;
    });

    return core;
};

let nesCoreInit: Promise<Core>;
let snesCoreInit: Promise<Core>;
let gbCoreInit: Promise<Core>;

export default async (data: WorkerData) => {
    const { coreType, input, duration, game, state, gameHash } = data;

    let core: Core;
    switch (coreType) {
        case CoreType.NES:
            core = await (nesCoreInit = nesCoreInit || NesCore().then(setup));
            break;

        case CoreType.SNES:
            core = await (snesCoreInit = snesCoreInit || SnesCore().then(setup));
            break;

        case CoreType.GBA:
        case CoreType.GB:
            core = await (gbCoreInit = gbCoreInit || GbCore().then(setup));
            break;

        default:
            throw new Error(`Unknown core type: ${coreType}`);
    }

    const incomingGameHash = gameHash
        ? gameHash
        : await crc32(game);

    let lastGameHash = '';

    switch (coreType) {
        case CoreType.NES:
            lastGameHash = lastNesGameHash;
            break;

        case CoreType.SNES:
            lastGameHash = lastSnesGameHash;
            break;

        case CoreType.GBA:
        case CoreType.GB:
            lastGameHash = lastGbGameHash;
            break;
    }

    if (incomingGameHash != lastGameHash || state?.byteLength == 0) {
        loadRom(core, game);

        switch (coreType) {
            case CoreType.NES:
                lastNesGameHash = incomingGameHash;
                break;

            case CoreType.SNES:
                lastSnesGameHash = incomingGameHash;
                break;

            case CoreType.GBA:
            case CoreType.GB:
                lastGbGameHash = incomingGameHash;
                break;
        }
    }

    const av_info: any = {};
    core.retro_get_system_av_info(av_info);

    if (state?.byteLength > 0) {
        loadState(core, state);
    }

    const executeFrame = () => new Promise<Frame>((res) => {
        core.retro_set_input_state((port: number, device: number, index: number, id: number) => {
            if (id == RETRO_DEVICE_ID_JOYPAD_MASK) {
                let mask = 0;

                if (input.A)
                    mask |= 1 << RETRO_DEVICE_ID_JOYPAD_A;

                if (input.B)
                    mask |= 1 << RETRO_DEVICE_ID_JOYPAD_B;

                if (input.X)
                    mask |= 1 << RETRO_DEVICE_ID_JOYPAD_X;

                if (input.Y)
                    mask |= 1 << RETRO_DEVICE_ID_JOYPAD_Y;

                if (input.SELECT)
                    mask |= 1 << RETRO_DEVICE_ID_JOYPAD_SELECT;

                if (input.START)
                    mask |= 1 << RETRO_DEVICE_ID_JOYPAD_START;

                if (input.UP)
                    mask |= 1 << RETRO_DEVICE_ID_JOYPAD_UP;

                if (input.DOWN)
                    mask |= 1 << RETRO_DEVICE_ID_JOYPAD_DOWN;

                if (input.LEFT)
                    mask |= 1 << RETRO_DEVICE_ID_JOYPAD_LEFT;

                if (input.RIGHT)
                    mask |= 1 << RETRO_DEVICE_ID_JOYPAD_RIGHT;

                return mask;
            }

            return 0;
        });

        core.retro_set_video_refresh((data: number, width: number, height: number, pitch: number) => {
            res({
                buffer: data
                    ? new Uint16Array(core.HEAPU16.subarray(data / 2, (data + pitch * height) / 2))
                    : null,
                width,
                height,
                pitch
            })
        });

        core.retro_run();
    });

    const frames: Frame[] = [];

    for (let i = 0; i < duration; i++) {
        frames.push(await executeFrame());
    }

    const newState = saveState(core);

    const output = {
        av_info,
        frames,
        state: newState,
        gameHash: incomingGameHash,

        get [Piscina.transferableSymbol]() {
            return [
                newState.buffer,
                ...frames.map(frame => frame.buffer.buffer)
            ];
        },

        get [Piscina.valueSymbol]() {
            return {
                av_info,
                frames,
                state: newState,
                gameHash: incomingGameHash
            };
        }
    };

    return Piscina.move(output as any);
}