import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Input } from '../../src/app/Input';
import { PlayerController } from '../../src/app/PlayerController';
import { DEFAULT_SETTINGS, type Settings } from '../../src/app/Profile';
import { DEFAULT_BINDINGS } from '../../src/config/controls';
import { OUTFITS } from '../../src/config/cosmetics';
import { Agent, makeWeapon } from '../../src/sim/entities/Agent';

// Regressions found in the 1.7.7 input review.

describe('raw keyboard input', () => {
  const handlers: Record<string, ((e: unknown) => void)[]> = {};
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  beforeAll(() => {
    // just enough of the browser for Input to register its listeners
    g.window = { addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] ??= []).push(fn) };
    g.document = { pointerLockElement: null, addEventListener: (type: string, fn: (e: unknown) => void) => (handlers['document:' + type] ??= []).push(fn) };
  });
  afterAll(() => { delete g.window; delete g.document; });
  const key = (code: string, down: boolean, extra: object = {}) =>
    handlers[down ? 'keydown' : 'keyup'].forEach((fn) => fn({ code, repeat: false, target: null, preventDefault() {}, ...extra }));

  it('never counts OS auto-repeat as a fresh press, even after held keys were forgotten', () => {
    const input = new Input({} as HTMLElement, { ...DEFAULT_BINDINGS });
    input.gameFocus = true;
    key('KeyA', true);
    expect(input.wasPressed('KeyA')).toBe(true);
    input.endFrame();
    input.clear(); // the pointer lock dropped (a menu opened) while A was still held
    key('KeyA', true, { repeat: true });
    expect(input.wasPressed('KeyA')).toBe(false); // the buy menu must not read this as "A: auto-buy"
    expect(input.isDown('KeyA')).toBe(true);
  });

  it('releases a key that is let go while a settings control has focus', () => {
    const input = new Input({} as HTMLElement, { ...DEFAULT_BINDINGS });
    input.gameFocus = true;
    key('KeyW', true);
    key('KeyW', false, { target: { tagName: 'INPUT' } });
    expect(input.isDown('KeyW')).toBe(false);
  });
});

describe('player controller', () => {
  const agent = () => {
    const a = new Agent('Player', 'T', false, { T: OUTFITS[0].look, CT: OUTFITS[3].look });
    a.secondary = makeWeapon('p30');
    return a;
  };
  /** A controllable stand-in for Input: `down` holds actions, `pressed` this frame's presses (actions and raw codes). */
  const stub = (locked = true) => {
    const down = new Set<string>(), pressed = new Set<string>();
    const input = {
      gameFocus: true, locked, consumeMouse: () => ({ dx: 0, dy: 0, wheel: 0 }),
      action: (a: string) => down.has(a), actionPressed: (a: string) => pressed.has(a),
      wasPressed: (code: string) => pressed.has(code), isDown: (code: string) => down.has(code),
    } as unknown as Input & { locked: boolean };
    return { input, down, pressed };
  };

  it('stands up from a toggled crouch on Space without hopping', () => {
    const { input, down, pressed } = stub();
    const ctrl = new PlayerController(input, { ...DEFAULT_SETTINGS, crouchMode: 'toggle' } as Settings);
    const a = agent();
    down.add('crouch'); ctrl.frame(a, 1, 1 / 60); down.clear(); ctrl.frame(a, 1, 1 / 60); // tap crouch
    expect(ctrl.command(a).crouch).toBe(true);
    down.add('jump'); pressed.add('jump'); ctrl.frame(a, 1, 1 / 60); pressed.clear();
    let c = ctrl.command(a);
    expect(c.crouch).toBe(false);
    expect(c.jump).toBe(false);
    ctrl.frame(a, 1, 1 / 60);
    expect(ctrl.command(a).jump).toBe(false); // still holding Space
    down.clear(); ctrl.frame(a, 1, 1 / 60); ctrl.command(a);
    down.add('jump'); pressed.add('jump'); ctrl.frame(a, 1, 1 / 60); pressed.clear();
    c = ctrl.command(a);
    expect(c.jump).toBe(true); // a fresh press jumps again
  });

  it('never carries an ADS toggle from a scoped rifle, or across a weapon switch', () => {
    const { input, pressed } = stub();
    const ctrl = new PlayerController(input, { ...DEFAULT_SETTINGS, adsToggle: true } as Settings);
    const a = agent();
    a.primary = makeWeapon('kestrel'); a.active = 'primary';
    pressed.add('Mouse2'); ctrl.frame(a, 1); pressed.clear(); // right-click the scoped rifle
    a.active = 'secondary'; ctrl.frame(a, 1);
    expect(ctrl.command(a).alt).toBe(false);
    pressed.add('Mouse2'); ctrl.frame(a, 1); pressed.clear(); // the pistol toggles normally
    expect(ctrl.command(a).alt).toBe(true);
    a.active = 'primary'; ctrl.frame(a, 1); a.active = 'secondary'; ctrl.frame(a, 1);
    expect(ctrl.command(a).alt).toBe(false); // switching weapons dropped the aim
  });

  it('applies aim assist only while the game has the pointer', () => {
    const pull = () => ({ sens: 1, yaw: 0.01, pitch: 0 });
    for (const locked of [false, true]) {
      const ctrl = new PlayerController(stub(locked).input, DEFAULT_SETTINGS);
      ctrl.assist = pull;
      ctrl.frame(agent(), 1, 1 / 60);
      expect(ctrl.yaw !== 0).toBe(locked);
    }
  });
});
