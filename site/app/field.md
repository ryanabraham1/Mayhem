# Field and obstacles

Switch to **Field** in the top bar. Every obstacle here applies to all paths.

![Field mode](/img/field-mode.jpg)

## Drawing obstacles

- **Polygon** (<kbd>P</kbd>): click corners; click the first corner, double-click or press <kbd>Enter</kbd> to finish.
- **Circle** (<kbd>C</kbd>): drag from the center.
- Select an obstacle to drag it, drag its corners, double-click an edge to add a corner, or <kbd>⇧</kbd>-click a corner to remove it.

## The obstacle list

- Checkboxes in the sidebar enable or disable obstacles.
- The REBUILT **bumps** and the overhead **trench openings** start disabled, since most robots drive over or under them. Enable the trenches if your robot is taller than 22.25 in.
- **Copy to other alliance** (the flip icon in the obstacle panel) mirrors an obstacle using the field symmetry.
- **Clearance margin** is extra space the robot keeps from that obstacle.
- **Rough terrain on every path** (per obstacle) marks it as terrain the robot drives over, such as a bump. Every path then gets a rough-terrain span wherever the robot center crosses it, with no zone to draw per path. See [Rough terrain](/app/constraints#rough-terrain). Turning it on also turns off **Enabled**, since paths must be allowed to cross it; the REBUILT bumps start this way.
- **Fuel sim** (per obstacle) chooses whether it blocks fuel. See [Fuel sim](/app/fuel-sim).

## Field settings

The field panel sets the field's name, length and width, the red-alliance flip (**Rotate 180°** for REBUILT, or **Mirror**) and the wall clearance. You can replace the whole field from a preset with **Load**; undo is available.

The geometry comes from the 2026 field drawings. Edit it to match your venue.
