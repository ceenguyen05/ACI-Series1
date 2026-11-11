import type { Action } from '../config/controls';

/** Keyboard + mouse state with pointer-lock handling. Mouse buttons are reported as 'Mouse0'..'Mouse4'. */
export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  /** When false, game actions are ignored (menus open). */
  gameFocus = false;
  bindings: Record<Action, string>;
  onLockChange: (locked: boolean) => void = () => {};
  /** Raw key listener for rebinding UI. */
  captureNext: ((code: string) => void) | null = null;

  constructor(private el: HTMLElement, bindings: Record<Action, string>) {
    this.bindings = bindings;
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('mousedown', (e) => this.onButton(e, true));
    window.addEventListener('mouseup', (e) => this.onButton(e, false));
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // guard against the occasional huge spike some browsers emit on lock
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => { if (this.locked) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('contextmenu', (e) => { if (this.gameFocus || this.locked) e.preventDefault(); });
    window.addEventListener('blur', () => this.clear());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.el;
      this.consumeMouse();
      if (!this.locked) this.clear();
      this.onLockChange(this.locked);
    });
  }

  private isTyping(e: Event) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
  }

  private onKey(e: KeyboardEvent, isDown: boolean) {
    if (this.captureNext && isDown) {
      e.preventDefault();
      const cb = this.captureNext; this.captureNext = null;
      cb(e.code);
      return;
    }
    const typing = this.isTyping(e);
    if (!typing && this.gameFocus && (Object.values(this.bindings).includes(e.code) || e.code.startsWith('Arrow') || e.code === 'Quote' || e.code === 'Slash')) e.preventDefault();
    // A key let go is no longer held, wherever focus is: released over a settings slider, it must
    // not stay "down" when you resume.
    if (!isDown) { this.down.delete(e.code); return; }
    if (typing) return;
    // OS auto-repeat is never a fresh press. After the pointer lock drops (a menu opens) the held
    // keys are cleared, and a strafe key's next repeat would otherwise press A in the buy menu.
    if (!e.repeat && !this.down.has(e.code)) this.pressed.add(e.code);
    this.down.add(e.code);
  }

  private onButton(e: MouseEvent, isDown: boolean) {
    const code = 'Mouse' + e.button;
    if (e.button === 1 && (this.locked || this.gameFocus)) e.preventDefault(); // middle-click ping, not autoscroll
    if (this.captureNext && isDown && this.captureNext) {
      const cb = this.captureNext; this.captureNext = null; cb(code); return;
    }
    if (!this.locked) { if (!isDown) this.down.delete(code); return; }
    if (isDown) { if (!this.down.has(code)) this.pressed.add(code); this.down.add(code); }
    else this.down.delete(code);
  }

  isDown(code: string) { return this.down.has(code); }
  wasPressed(code: string) { return this.pressed.has(code); }
  action(a: Action) { return this.gameFocus && this.down.has(this.bindings[a]); }
  actionPressed(a: Action) { return this.gameFocus && this.pressed.has(this.bindings[a]); }

  consumeMouse() {
    const r = { dx: this.mouseDX, dy: this.mouseDY, wheel: this.wheel };
    this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0;
    return r;
  }

  endFrame() { this.pressed.clear(); }

  async requestLock() {
    if (this.locked) return;
    try {
      await this.el.requestPointerLock({ unadjustedMovement: true });
    } catch (error) {
      // Browsers / platforms without raw mouse support still get normal pointer lock.
      if (error instanceof DOMException && error.name === 'NotSupportedError') {
        try { await this.el.requestPointerLock(); } catch { /* requires a user gesture */ }
      }
    }
  }
  exitLock() { if (document.pointerLockElement) document.exitPointerLock(); }
  clear() { this.down.clear(); this.pressed.clear(); this.consumeMouse(); }
}
