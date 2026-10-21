/*
 * PolyTrack Tweaks — look around the garage.
 *
 * The garage only orbits the car. This gives it the race's spectator camera: press the spectator
 * camera key (the game's own binding, "/" unless changed) or the Look around button, then fly with
 * the spectator keys and drag the mouse to look. The same key, Escape or the button goes back.
 *
 * It is the game's own spectator camera class, driven at a garage-sized speed (the race's 50 units a
 * second would cross the whole garage in a blink).
 */
(function () {
  'use strict';

  const SPEED = 0.12;          // of the race's spectator speed: 6 units a second, 48 with the speed key
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  const CSS = `
.customization-ui.pt-free-look > *:not(.top) { display:none !important; }
.customization-ui.pt-free-look > .top > *:not(.pt-look) { visibility:hidden; }
.pt-look-hint { position:absolute; left:50%; bottom:28px; transform:translateX(-50%); z-index:40; padding:8px 16px;
  background:rgba(20,20,30,0.62); color:var(--text-color,#eef1ff); font-size:18px; line-height:1.5; text-align:center;
  pointer-events:none; white-space:nowrap; }
.pt-look-hint .pt-key { font-size:15px; }
`;

  const PTGarageCam = {
    /**
     * Called by the garage once its orbit camera exists.
     * renderer: the game's renderer wrapper; camera: the orbit camera; controls: its OrbitControls;
     * ui: the garage's .customization-ui element.
     */
    create({ renderer, camera, controls, ui }) {
      const Spectator = window.__ptSpectatorCam, settings = window.__ptSettingsMgr;
      if (!Spectator || !settings || !window.__ptKeyEnum) return null;
      if (!document.getElementById('pt-garage-css')) {
        const st = el('style'); st.id = 'pt-garage-css'; st.textContent = CSS;
        document.head.appendChild(st);
      }

      const spectator = new Spectator(renderer, settings);
      spectator.camera.near = camera.near;
      spectator.camera.fov = camera.fov;
      spectator.camera.updateProjectionMatrix();
      let hint = null;

      const button = el('button', 'button pt-look');
      button.innerHTML = '<img class="button-icon" src="images/preview.svg"> ';
      const label = document.createTextNode('Look around');
      button.appendChild(label);
      const top = ui.querySelector('.top');
      if (top) top.insertBefore(button, top.querySelector('.right'));

      const cam = {
        get active() { return spectator.isEnabled; },

        enable() {
          if (spectator.isEnabled) return;
          // start where the orbit camera is, level (as the race's spectator camera does)
          const c = spectator.camera;
          c.position.copy(camera.position);
          const THREE_Euler = camera.rotation.constructor;
          const e = new THREE_Euler(0, 0, 0, 'YXZ').setFromQuaternion(camera.quaternion);
          e.x = Math.round(1e4 * e.x) / 1e4; e.y = Math.round(1e4 * e.y) / 1e4; e.z = 0;
          c.quaternion.setFromEuler(e);
          spectator.isEnabled = true;
          controls.enabled = false;
          renderer.setCamera(c);
          ui.classList.add('pt-free-look');
          label.textContent = 'Back to the car';
          hint = this.hint();
          (document.getElementById('ui') || document.body).appendChild(hint);
        },

        disable() {
          if (!spectator.isEnabled) return;
          spectator.isEnabled = false;
          controls.enabled = true;
          renderer.setCamera(camera);
          ui.classList.remove('pt-free-look');
          label.textContent = 'Look around';
          if (hint) { hint.remove(); hint = null; }
        },

        toggle() { if (spectator.isEnabled) this.disable(); else this.enable(); },

        update(dt) { spectator.update(dt * SPEED); },

        hint() {
          const h = el('div', 'pt-look-hint');
          const K = window.PTKeys;
          const add = (names, what) => {
            names.forEach((n, i) => { if (i) h.appendChild(document.createTextNode(' ')); h.appendChild(K ? K.caps(n) : document.createTextNode('?')); });
            h.appendChild(document.createTextNode(' ' + what));
          };
          add(['SpectatorMoveForwards', 'SpectatorMoveLeft', 'SpectatorMoveBackwards', 'SpectatorMoveRight'], 'move  ·  ');
          // the game's "Move up" binding moves the camera down (and "Move down" up), as in a race
          add(['SpectatorMoveUp'], 'down  ·  ');
          add(['SpectatorMoveDown'], 'up  ·  ');
          add(['SpectatorSpeedModifier'], 'faster  ·  drag to look');
          h.appendChild(el('br'));
          add(['ToggleSpectatorCamera'], 'or ');
          h.appendChild(K ? Object.assign(el('kbd', 'pt-key'), { textContent: 'Esc' }) : document.createTextNode('Esc'));
          h.appendChild(document.createTextNode(' back to the car'));
          return h;
        },

        dispose() {
          this.disable();
          spectator.dispose();
          window.removeEventListener('keydown', onKey, true);
          button.remove();
        },
      };

      // capture phase: Escape must reach us before the garage's own handler, which leaves the garage
      const onKey = (e) => {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
        if (!ui.isConnected || ui.classList.contains('hidden')) return;     // a dialog or the profile screen is up
        if (e.code === 'Escape' && spectator.isEnabled) {
          cam.disable(); e.preventDefault(); e.stopImmediatePropagation(); return;
        }
        if (settings.checkKeyBinding(e, window.__ptKeyEnum.ToggleSpectatorCamera)) {
          cam.toggle(); e.preventDefault(); e.stopImmediatePropagation();
        }
      };
      window.addEventListener('keydown', onKey, true);
      button.addEventListener('click', () => cam.toggle());
      return cam;
    },
  };

  window.PTGarageCam = PTGarageCam;
})();
