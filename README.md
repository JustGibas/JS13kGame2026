# JS13kGame2026
Second Time in a Game jam

[Watch the gameplay video](https://youtu.be/DQyQrR82AYw)

# Text in js13kgames website

> **MawLight.** The farther you go, the harder it gets.
> **Farm. Upgrade. Push forward.**

Start near spawn and defeat mobs. Collect **white spiny orbs** for XP; level up and choose 1 of 3 cards.

When you’re ready, step into a **colored beacon** to start a defense. Protect it through every wave to earn a powerful upgrade.

Keep moving away from spawn. Enemies get stronger, but so do the rewards. Build your power, push deeper, and take down the boss.

**Green orbs heal. Magnets attract XP.**

**Menu:** ON/OFF shows current state. Press to toggle.

| Button | Action |
| --- | --- |
| <kbd>MMO</kbd> | Toggle multiplayer |
| <kbd>VR</kbd> | Enter/Exit VR |
| <kbd>AUDIO</kbd> | Toggle all sound |
| <kbd>SHOTS</kbd> | Toggle projectile sounds |
| <kbd>SWAP</kbd> | Swap left/right controls: VR/mobile |
| <kbd>INVERT</kbd> | Reverse X/Y look: desktop/mobile |
| <kbd>LOCK</kbd> | Click to Lock cursor |
| <kbd>CLOSE</kbd> | Close menu |

| Action | VR controllers | VR hands | Mobile | Desktop |
| --- | --- | --- | --- | --- |
| Move | <kbd>Right stick</kbd> | <kbd>Right hand</kbd> | <kbd>Right side</kbd> | <kbd>WASD</kbd> / <kbd>↑↓</kbd> |
| Turn | <kbd>Left stick</kbd> | <kbd>Left hand</kbd> | <kbd>Left side</kbd> | <kbd>QE</kbd> / <kbd>←→</kbd> |
| Look | <kbd>Head</kbd> | <kbd>Head</kbd> | <kbd>Drag</kbd> | <kbd>Mouse</kbd> / <kbd>Click-drag</kbd> |
| Select | Aim + <kbd>Trigger</kbd> | Aim + <kbd>Pinch</kbd> | <kbd>Tap</kbd> | <kbd>Click</kbd> / <kbd>1</kbd> <kbd>2</kbd> <kbd>3</kbd> |

**VR hands controls:** point your <kbd>Index finger</kbd> or <kbd>Thumb</kbd> where you want to move or turn.

**Desktop UI:** Click <kbd>LOCK</kbd> to lock cursor. <kbd>F11</kbd> for fullscreen. If blurry UI, <kbd>Ctrl</kbd>+<kbd>0</kbd> resets zoom.

**No external resources.** All assets, data, and code are in the .zip. No external libraries, not even the allowed ones.

>Special thanks to Mindaugas Cartilli and my close friends for playtesting and sharing their feedback. Thanks for helping bring MawLight out of the void!

---

## MawLight

A browser survival game made for js13kgames 2026, with desktop, mobile, and VR controls. Defeat enemies, collect upgrades, defend beacons, and push deeper into the world to face the bosses.

### Play locally

Open `index.html` in your browser. All game code and assets are contained in this file. See the controls above.

### Build

Install Node.js and 7-Zip, then run:

```sh
npm install
npm run build
```

The build minifies the game and creates a compressed ZIP for submission. If 7-Zip is not detected, set `SEVEN_ZIP` to its executable path.

### License

Created by Justinas Gibas. Licensed under [Apache 2.0](LICENSE).
